// Format-drift sweep: parse + align + re-export EVERY .fwbackup in ~/Downloads/fwsamples
// (official SIL sample projects spanning format versions 7000068→7000072,
// downloaded from https://software.sil.org/fieldworks/download/sample-projects/)
// and assert the structural invariants hold. Drop any new backup into that
// directory and it joins the sweep. Skipped when the directory is absent (CI).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { cpLength } from '@larc-iu/plaid-client';
import { readFwbackup } from './fwbackup.js';
import { parseFwdata } from './fwdataParser.js';
import { buildDocuments } from './buildDocuments.js';
import { deriveImportConfig, importLexicon } from './importEngine.js';
import { buildLiftLexicon } from '../../export/lift.js';

const DIR = '/home/luke/Downloads/fwsamples';

// Captures what importLexicon would create, so the sweep can push a real FLEx
// lexicon straight back out as LIFT without a server.
function lexiconCapture() {
  const items = [];
  const config = { igt: {} };
  return {
    items,
    config,
    vocabLayers: {
      get: async () => ({ id: 'v1', items: [], config: {} }),
      // Kept, because the field schema is where the importer records which
      // writing system a single-writing-system field is in, and the LIFT
      // export reads it back out.
      setConfig: async (_id, _ns, key, value) => {
        config.igt[key] = value;
      },
    },
    vocabItems: {
      bulkCreate: async (body) => {
        const ids = body.map((b, i) => {
          const id = `i${items.length + i + 1}`;
          items.push({ id, form: b.form, metadata: b.metadata });
          return id;
        });
        return { ids };
      },
    },
  };
}

// Characters XML 1.0 forbids outright: no escaping saves them, and one of them
// anywhere would make FLEx reject the whole file.
const BAD_XML_CHAR = new RegExp(
  '[' + '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF' + ']',
);
const samples = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.fwbackup'))
  : [];

describe.skipIf(samples.length === 0)('fwbackup sample sweep', () => {
  it.for(samples)('%s parses, aligns, and re-exports as LIFT', async (file) => {
    const { xml } = readFwbackup(new Uint8Array(readFileSync(`${DIR}/${file}`)));
    const ir = parseFwdata(xml);
    const build = buildDocuments(ir);
    const { documents, stats } = build;

    // every word the file claims must align to the surface
    expect(stats.unalignedWords).toBe(0);
    expect(stats.warnings).toBe(0);

    for (const doc of documents) {
      const len = cpLength(doc.body);
      if (doc.body.length > 0) {
        // sentences tile the body exactly (partitioning invariant)
        expect(doc.sentences[0].begin).toBe(0);
        expect(doc.sentences[doc.sentences.length - 1].end).toBe(len);
        for (let i = 1; i < doc.sentences.length; i += 1) {
          expect(doc.sentences[i].begin).toBe(doc.sentences[i - 1].end);
        }
      }
      // words in order, in bounds, non-overlapping
      let prev = 0;
      for (const w of doc.words) {
        expect(w.begin).toBeGreaterThanOrEqual(prev);
        expect(w.end).toBeGreaterThan(w.begin);
        expect(w.end).toBeLessThanOrEqual(len);
        prev = w.end;
      }
    }

    // ---- and straight back out as LIFT (see src/export/lift.js) ----
    // Real lexicons are where the export's edge cases live: multi-sense
    // entries, non-Latin scripts, a non-English analysis language, FLEx
    // custom fields (Sena has three).
    const config = deriveImportConfig(ir, build, { lexiconFields: ir.lexiconFields ?? [] });
    const client = lexiconCapture();
    await importLexicon({
      client,
      vocabId: 'v1',
      lexicon: ir.lexicon,
      baselineWs: config.baselineWs,
      primaryAnalysisWs: config.primaryAnalysisWs,
      lexiconFields: config.lexiconFields,
      customFieldWs: config.customFieldWs,
    });
    const { lift, ranges, entryCount, senseCount } = buildLiftLexicon({
      vocabularies: [{ id: 'v1', items: client.items, config: client.config }],
      options: { langs: { baseline: config.baselineWs, analysis: config.primaryAnalysisWs } },
      rangesHref: 'sweep.lift-ranges',
    });

    for (const [label, doc] of [
      ['lift', lift],
      ['ranges', ranges],
    ]) {
      if (doc == null) continue;
      expect(BAD_XML_CHAR.test(doc), `${label} holds characters XML 1.0 forbids`).toBe(false);
      const dom = new DOMParser().parseFromString(doc, 'text/xml');
      expect(dom.querySelector('parsererror'), `${label} is not well-formed`).toBeNull();
    }

    const dom = new DOMParser().parseFromString(lift, 'text/xml');
    expect(dom.querySelectorAll('entry').length).toBe(entryCount);
    expect(dom.querySelectorAll('lexical-unit').length).toBe(entryCount);
    expect(dom.querySelectorAll('sense').length).toBe(senseCount);
    expect(senseCount).toBeLessThanOrEqual(client.items.length);

    // Grouping, checked against the items rather than against the exporter's
    // own bookkeeping: one entry per distinct FLEx entry guid, and items that
    // never came from FLEx stand alone. Counting these here is what makes the
    // assertion an oracle instead of a restatement.
    const formed = client.items.filter((i) => i.form);
    const distinctEntries = new Set(formed.map((i) => i.metadata?.flexEntry ?? `item:${i.id}`))
      .size;
    expect(entryCount).toBe(distinctEntries);

    // A FLEx custom field pinned to the vernacular has to come out tagged
    // vernacular. Sena's "Plural" is the real case: its values are bare
    // strings, so the field's own writing system is the only record of what
    // language they are in. The expectation is read straight off the file's
    // own <CustomField wsSelector> rather than from the importer's reading of
    // it, or this would just be the pipeline agreeing with itself.
    for (const f of ir.customFields ?? []) {
      if (f.class !== 'LexEntry' && f.class !== 'LexSense') continue;
      const form = dom.querySelector(`sense field[type="${f.name}"] form`);
      if (!form) continue;
      const vernacular = String(f.wsSelector) === '-2';
      expect(form.getAttribute('lang'), `custom field "${f.name}"`).toBe(
        vernacular ? config.baselineWs : config.primaryAnalysisWs,
      );
    }

    // ...and where the source lexicon actually has multi-sense entries, the
    // export has to show them rejoined, not flattened back into one entry each.
    const multiSense = ir.lexicon.filter((e) => (e.senses?.length ?? 0) > 1).length;
    if (multiSense > 0) {
      const rejoined = [...dom.querySelectorAll('entry')].filter(
        (e) => e.querySelectorAll('sense').length > 1,
      ).length;
      expect(rejoined).toBeGreaterThan(0);
    }
  });
});
