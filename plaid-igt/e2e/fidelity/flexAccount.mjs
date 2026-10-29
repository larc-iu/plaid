// What a FieldWorks project holds, against what its import made of it.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/flexAccount.mjs \
//     [--dir <path>] [--file <path>] [--docs N] [--keep]
//
// Every other importer has something that says what should have landed: a
// round trip reads back what we wrote and a loss list says what may go missing
// on the way. A .fwbackup has neither — Plaid cannot write one, so there is
// nothing to round-trip — and it is how real projects arrive. So this counts
// instead, three times over:
//
//   file     the units the parser found in the .fwbackup
//   plan     the units the importer decided to write (buildDocuments)
//   project  the units the server holds once the engine has run
//
// A unit that is in the file and not in the plan is the builder's doing, and
// the builder has to have SAID so: each document's `leftOut` lists the word
// analyses it does not import (could not place, or punctuation only, left as
// text). What a word it could not place held is accounted for. A punctuation
// word is accounted for only as a word and its morphemes, since real
// punctuation holds nothing more, so a real word wrongly sent down that path
// shows its glosses and links lost. Anything else unaccounted for
// is a finding. A unit that is in the
// plan and not in the project is the engine's doing, and there is no such
// thing as an acceptable one.
//
// Counting is not comparing: two glosses of the same length are one gloss each
// here whatever they say. This is the cheap oracle for "nothing fell out", and
// it says where, not what.
//
// The core is the campaign's private one (core.mjs), never the dev core.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../src/test/fixturesDir.js';
import { coreForRun } from './core.mjs';
import { importParsed, parseBackup } from './flexImport.mjs';
import { snapshotProject } from './snapshot.mjs';

const DEFAULT_DIR = fixture('fwsamples');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const docCap = Number(arg('--docs') ?? 0);
const keep = process.argv.includes('--keep');
const one = arg('--file');
const dir = arg('--dir', DEFAULT_DIR);
const backups = one
  ? [one]
  : readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.fwbackup'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(a).size - statSync(b).size);
if (!backups.length) throw new Error(`no .fwbackup files in ${dir}`);

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const filled = (v) => typeof v === 'string' && v.trim() !== '';
/** The non-empty strings in a multi-writing-system value ({ws: text}). */
const strings = (m) => (m && typeof m === 'object' ? Object.values(m).filter(filled) : []);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);

/**
 * The entries and senses a lexicon is worth as ITEMS. An entry with one sense
 * is that sense — the importer writes one item for the two — and an entry with
 * several is a container item holding one item per sense. So every entry is
 * worth one parentless item, and only the senses of a multi-sense entry are
 * worth an item of their own.
 */
const lexiconCounts = (ir) => ({
  entries: ir.lexicon.length,
  senses: sum(ir.lexicon, (e) => (e.senses.length > 1 ? e.senses.length : 0)),
  // An example is kept when it has a text of its own; its translation rides
  // along with it.
  examples: sum(ir.lexicon, (e) =>
    sum(e.senses || [], (sn) => (sn.examples || []).filter((ex) => strings(ex.text).length).length),
  ),
  // A custom field's value, on an entry or on one of its senses. Written per
  // writing system, as every imported field is.
  // A custom field's value, counted as the items it is written on. Each is
  // written per writing system, as every imported field is, and an ENTRY's
  // values go on every item that entry is worth: a sense item carries the
  // entry's fields as well as its own.
  customValues: sum(ir.lexicon, (e) => {
    const on = (owner) =>
      sum(Object.values(owner?.custom || {}), (v) => strings(v).length || (filled(v) ? 1 : 0));
    const items = e.senses.length > 1 ? 1 + e.senses.length : 1;
    return on(e) * items + sum(e.senses || [], on);
  }),
});

/**
 * What a text says about ITSELF: its titles and abbreviations, where it came
 * from, what it is about, its genres, and the fields of the notebook record it
 * belongs to. Counted by distinct value rather than by writing system, since
 * two writing systems holding one string are one fact and land as one.
 *
 * Deliberately coarse. It does not say which fact is which, only how many a
 * text has, which is enough to notice a whole kind going missing — the
 * notebook record, say, which no other count would show.
 */
function textFacts(t) {
  const distinct = (m) => new Set(strings(m)).size;
  const nb = t.notebook;
  return (
    distinct(t.names) +
    distinct(t.abbreviations) +
    (strings(t.source).length ? 1 : 0) +
    (strings(t.description).length ? 1 : 0) +
    (t.genres?.length ? 1 : 0) +
    (nb
      ? ['researchers', 'sources', 'participants', 'locations', 'anthroCodes'].filter(
          (k) => (nb[k] || []).length,
        ).length
      : 0)
  );
}

/**
 * What a list of words holds: the words, their glosses and categories, and
 * their morphemes with theirs. A morph bundle links to the lexicon when it
 * names a sense the lexicon holds. One that names a sense the file does not
 * have cannot be linked by anything, so it is not counted as a link that went
 * missing. The file, the plan and what the builder left out are all counted
 * by this one reading.
 */
function wordCounts(words, ir) {
  const senseGuids = new Set(
    ir.lexicon.flatMap((e) => [e.guid, ...(e.senses || []).map((sn) => sn.guid)]),
  );
  const morphemes = words.flatMap((w) => w.morphemes || []);
  return {
    links: morphemes.filter((m) => m.senseGuid && senseGuids.has(m.senseGuid)).length,
    words: words.length,
    morphemes: morphemes.length,
    wordGlosses: sum(words, (w) => strings(w.gloss).length),
    wordPos: words.filter((w) => filled(w.pos)).length,
    morphGlosses: sum(morphemes, (m) => strings(m.gloss).length),
    morphPos: morphemes.filter((m) => filled(m.pos)).length,
  };
}

/** A sentence's notes, one per string in each writing system. */
const noteCount = (notes) => sum(notes || [], (n) => strings(n).length);

/**
 * The import writes a sentence's notes in one language as one value, a line
 * each (importEngine.js), so three notes on a sentence are one span in the
 * project (REV-RT 5). Each such span the plan makes, as its joined text, with
 * the note strings it is worth. A project span holding exactly that text
 * holds each of them, so a join that drops any note but the first counts its
 * notes lost (REV-FL F2).
 */
const plannedNoteJoins = (sentences) =>
  sentences.flatMap((s) => {
    const byWs = new Map();
    for (const n of s.notes || []) {
      for (const [ws, v] of Object.entries(n || {})) {
        if (!v) continue;
        if (!byWs.has(ws)) byWs.set(ws, []);
        byWs.get(ws).push(v);
      }
    }
    return [...byWs.values()].map((vs) => ({
      text: vs.join('\n'),
      worth: vs.filter(filled).length,
    }));
  });

/** What the parser found, over the texts this run imported. */
function countFile(ir, keptGuids) {
  const texts = ir.texts.filter((t) => keptGuids.has(t.guid));
  const segments = texts.flatMap((t) => t.paragraphs.flatMap((p) => p.segments));
  const analyses = segments.flatMap((s) => s.analyses.filter((a) => a.kind === 'word'));
  return {
    textFacts: sum(texts, textFacts),
    ...wordCounts(analyses, ir),
    documents: texts.length,
    sentences: segments.length,
    translations: sum(segments, (s) => strings(s.freeTranslation).length),
    literalTranslations: sum(segments, (s) => strings(s.literalTranslation).length),
    notes: sum(segments, (s) => noteCount(s.notes)),
    ...lexiconCounts(ir),
  };
}

/** What the importer decided to write. */
function countPlan(build, ir) {
  const docs = build.documents;
  const sentences = docs.flatMap((d) => d.sentences);
  return {
    textFacts: sum(docs, (d) =>
      textFacts({
        names: d.names,
        abbreviations: d.abbreviations,
        source: d.source,
        description: d.description,
        genres: d.genres,
        notebook: d.notebook,
      }),
    ),
    ...wordCounts(
      docs.flatMap((d) => d.words),
      ir,
    ),
    documents: docs.length,
    sentences: sentences.length,
    translations: sum(sentences, (s) => strings(s.freeTranslation).length),
    literalTranslations: sum(sentences, (s) => strings(s.literalTranslation).length),
    notes: sum(sentences, (s) => noteCount(s.notes)),
    ...lexiconCounts(ir),
  };
}

/**
 * What the server holds. A field's name is its base plus the writing system.
 * Notes are counted as the planned note strings a Note span holds.
 */
function countProject(snapshot, build) {
  const docs = snapshot.documents || [];
  const tokens = (role) => docs.flatMap((d) => d.tokens.filter((t) => t.layer === `token:${role}`));
  const spans = docs.flatMap((d) => d.spans);
  const layer = (key) => (snapshot.layers || []).find((l) => l.key === key);
  const namedSpans = (scope, base) =>
    spans.filter((sp) => {
      const l = layer(sp.layer);
      if (!l || l.config?.igt?.scope !== scope) return false;
      return l.name === base || l.name.startsWith(`${base} (`);
    });
  const named = (scope, base) => namedSpans(scope, base).length;
  // Each Note span's text is used up by one planned join at most.
  const noteTexts = new Map();
  for (const sp of namedSpans('Sentence', 'Note')) {
    noteTexts.set(sp.value, (noteTexts.get(sp.value) ?? 0) + 1);
  }
  const notesHeld = sum(
    plannedNoteJoins(build.documents.flatMap((d) => d.sentences)),
    ({ text, worth }) => {
      const n = noteTexts.get(text) ?? 0;
      if (!n) return 0;
      noteTexts.set(text, n - 1);
      return worth;
    },
  );
  const items = (snapshot.vocabularies || []).flatMap((v) => v.items || []);
  // What the importer writes itself, so what is left is the project's own
  // fields: the values a FLEx custom field brought over.
  const OWN = new Set([
    'gloss',
    'pos',
    'definition',
    'morphType',
    'lexemeForm',
    'homograph',
    'examples',
    'parent',
    'senseOrder',
    'flexEntry',
    'flexSense',
    'prov',
    'provSource',
    'provConfirmed',
  ]);
  const base = (key) => key.replace(/\s\([^()]+\)$/, '');
  return {
    // One of the text's titles became the document's name rather than a
    // metadata value, so it is counted back in.
    textFacts: sum(docs, (d) => Object.keys(d.metadata || {}).length + 1),
    links: docs.flatMap((d) => d.links || []).length,
    examples: sum(items, (it) =>
      Array.isArray(it.metadata?.examples) ? it.metadata.examples.length : 0,
    ),
    customValues: sum(
      items,
      (it) => Object.entries(it.metadata || {}).filter(([k]) => !OWN.has(base(k))).length,
    ),
    documents: docs.length,
    sentences: tokens('sentence').length,
    words: tokens('word').length,
    morphemes: tokens('morpheme').length,
    wordGlosses: named('Word', 'Gloss'),
    wordPos: named('Word', 'POS'),
    morphGlosses: named('Morpheme', 'Gloss'),
    morphPos: named('Morpheme', 'POS'),
    translations: named('Sentence', 'Translation'),
    literalTranslations: named('Sentence', 'Literal Translation'),
    notes: notesHeld,
    entries: items.filter((it) => it.metadata?.parent == null).length,
    senses: items.filter((it) => it.metadata?.parent != null).length,
  };
}

const KINDS = [
  'documents',
  'sentences',
  'words',
  'morphemes',
  'wordGlosses',
  'wordPos',
  'morphGlosses',
  'morphPos',
  'translations',
  'literalTranslations',
  'notes',
  'textFacts',
  'entries',
  'senses',
  'links',
  'examples',
  'customValues',
];

const core = await coreForRun({ keep });
let failures = 0;
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);

  for (const path of backups) {
    const label = path
      .split('/')
      .pop()
      .replace(/\.fwbackup$/i, '');
    let parsed;
    let snapshot;
    try {
      parsed = parseBackup(path, { docCap });
      const done = await importParsed(client, parsed, `${label} ${Date.now() % 1e6}`);
      snapshot = await snapshotProject(client, done.projectId);
    } catch (err) {
      failures += 1;
      console.log(`\n${label}\n  FAIL the import: ${err.message}`);
      continue;
    }

    const kept = new Set(parsed.build.documents.map((d) => d.guid));
    const file = countFile(parsed.ir, kept);
    const plan = countPlan(parsed.build, parsed.ir);
    const project = countProject(snapshot, parsed.build);
    // What the builder said it left behind, counted from the words it named:
    // a word it could not place, with its glosses, category, morphemes and
    // links, and a word of punctuation only, which stays text (8aa867863), as
    // the word and its morphemes alone. Only that is allowed, so a gloss
    // dropped from a word that did land is a finding, and so is any gloss,
    // category or link on a word the builder called punctuation (REV-FL F1).
    const unaligned = wordCounts(
      parsed.build.documents.flatMap((d) => d.leftOut.unaligned),
      parsed.ir,
    );
    const punctuation = wordCounts(
      parsed.build.documents.flatMap((d) => d.leftOut.punctuation),
      parsed.ir,
    );
    const said = {
      ...unaligned,
      words: unaligned.words + punctuation.words,
      morphemes: unaligned.morphemes + punctuation.morphemes,
    };

    console.log(`\n${label}${docCap ? ` (${docCap} smallest texts)` : ''} (${secs()})`);
    const findings = [];
    for (const kind of KINDS) {
      const inFile = file[kind];
      const inPlan = plan[kind];
      const inProject = project[kind];
      const allowed = said[kind] ?? 0;
      const lostInBuild = inFile - inPlan - allowed;
      const lostInEngine = inPlan - inProject;
      if (lostInBuild > 0) {
        findings.push(
          `${kind}: ${inFile} in the file, ${inPlan} in the plan` +
            `${allowed ? ` (${allowed} on words reported left out)` : ''}, ${lostInBuild} unaccounted for`,
        );
      }
      if (lostInEngine > 0) {
        findings.push(
          `${kind}: ${inPlan} planned, ${inProject} in the project, ${lostInEngine} lost`,
        );
      }
      const mark = lostInBuild > 0 || lostInEngine > 0 ? 'FAIL' : ' ok ';
      console.log(
        `  ${mark} ${kind.padEnd(19)} file ${String(inFile).padStart(6)}` +
          `   plan ${String(inPlan).padStart(6)}   project ${String(inProject).padStart(6)}`,
      );
    }
    for (const f of findings) console.log(`       ${f}`);
    failures += findings.length;
  }
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await core.stop();
}
console.log(
  `\n${failures ? `${failures} finding(s)` : 'every unit lands or is accounted for'}, ${secs()}`,
);
process.exit(failures ? 1 : 0);
