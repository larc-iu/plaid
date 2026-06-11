// Format-drift sweep: parse + align EVERY .fwbackup in ~/Downloads/fwsamples
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

const DIR = '/home/luke/Downloads/fwsamples';
const samples = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.fwbackup'))
  : [];

describe.skipIf(samples.length === 0)('fwbackup sample sweep', () => {
  it.for(samples)('%s parses and aligns cleanly', (file) => {
    const { xml } = readFwbackup(new Uint8Array(readFileSync(`${DIR}/${file}`)));
    const ir = parseFwdata(xml);
    const { documents, stats } = buildDocuments(ir);

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
  });
});
