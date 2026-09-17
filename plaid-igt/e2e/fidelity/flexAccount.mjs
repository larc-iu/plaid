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
// the builder has to have SAID so: `unalignedWords` is the one such report it
// makes, and anything else unaccounted for is a finding. A unit that is in the
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
import { coreForRun } from './core.mjs';
import { importParsed, parseBackup } from './flexImport.mjs';
import { snapshotProject } from './snapshot.mjs';

const DEFAULT_DIR = '/home/luke/Downloads/fwsamples';

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
// What an import writes on a document to know where it got to: not the text's
// own doing, so not counted as one of its facts.
const STAMPS = new Set(['importSource', 'importDone']);
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

/** What the parser found, over the texts this run imported. */
function countFile(ir, keptGuids) {
  const texts = ir.texts.filter((t) => keptGuids.has(t.guid));
  const segments = texts.flatMap((t) => t.paragraphs.flatMap((p) => p.segments));
  const analyses = segments.flatMap((s) => s.analyses.filter((a) => a.kind === 'word'));
  const bundles = analyses.flatMap((a) => a.morphemes || []);
  // A morph bundle links to the lexicon when it names a sense the lexicon
  // holds. One that names a sense the file does not have cannot be linked by
  // anything, so it is not counted as a link that went missing.
  const senseGuids = new Set(
    ir.lexicon.flatMap((e) => [e.guid, ...(e.senses || []).map((sn) => sn.guid)]),
  );
  return {
    textFacts: sum(texts, textFacts),
    links: bundles.filter((m) => m.senseGuid && senseGuids.has(m.senseGuid)).length,
    documents: texts.length,
    sentences: segments.length,
    words: analyses.length,
    morphemes: bundles.length,
    wordGlosses: sum(analyses, (a) => strings(a.gloss).length),
    wordPos: analyses.filter((a) => filled(a.pos)).length,
    morphGlosses: sum(bundles, (m) => strings(m.gloss).length),
    morphPos: bundles.filter((m) => filled(m.pos)).length,
    translations: sum(segments, (s) => strings(s.freeTranslation).length),
    literalTranslations: sum(segments, (s) => strings(s.literalTranslation).length),
    notes: sum(segments, (s) => sum(s.notes || [], (n) => strings(n).length)),
    ...lexiconCounts(ir),
  };
}

/** What the importer decided to write. */
function countPlan(build, ir) {
  const docs = build.documents;
  const words = docs.flatMap((d) => d.words);
  const morphemes = words.flatMap((w) => w.morphemes || []);
  const sentences = docs.flatMap((d) => d.sentences);
  const senseGuids = new Set(
    ir.lexicon.flatMap((e) => [e.guid, ...(e.senses || []).map((sn) => sn.guid)]),
  );
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
    links: morphemes.filter((m) => m.senseGuid && senseGuids.has(m.senseGuid)).length,
    documents: docs.length,
    sentences: sentences.length,
    words: words.length,
    morphemes: morphemes.length,
    wordGlosses: sum(words, (w) => strings(w.gloss).length),
    wordPos: words.filter((w) => filled(w.pos)).length,
    morphGlosses: sum(morphemes, (m) => strings(m.gloss).length),
    morphPos: morphemes.filter((m) => filled(m.pos)).length,
    translations: sum(sentences, (s) => strings(s.freeTranslation).length),
    literalTranslations: sum(sentences, (s) => strings(s.literalTranslation).length),
    notes: sum(sentences, (s) => sum(s.notes || [], (n) => strings(n).length)),
    ...lexiconCounts(ir),
  };
}

/** What the server holds. A field's name is its base plus the writing system. */
function countProject(snapshot) {
  const docs = snapshot.documents || [];
  const tokens = (role) => docs.flatMap((d) => d.tokens.filter((t) => t.layer === `token:${role}`));
  const spans = docs.flatMap((d) => d.spans);
  const layer = (key) => (snapshot.layers || []).find((l) => l.key === key);
  const named = (scope, base) =>
    spans.filter((sp) => {
      const l = layer(sp.layer);
      if (!l || l.config?.igt?.scope !== scope) return false;
      return l.name === base || l.name.startsWith(`${base} (`);
    }).length;
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
    textFacts: sum(
      docs,
      (d) => Object.keys(d.metadata || {}).filter((k) => !STAMPS.has(k)).length + 1,
    ),
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
    notes: named('Sentence', 'Note'),
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
    const project = countProject(snapshot);
    // What the builder said it left behind. A word it could not place takes
    // its glosses, its category and its morphemes with it, so those are
    // accounted for by the word rather than counted again.
    const unaligned = file.words - plan.words;
    const said = {
      words: parsed.stats.unalignedWords,
      // Only meaningful when a word was left behind, and then only as "these
      // went with it": the file's counts do not say which word held what.
      morphemes: unaligned ? file.morphemes - plan.morphemes : 0,
      wordGlosses: unaligned ? file.wordGlosses - plan.wordGlosses : 0,
      wordPos: unaligned ? file.wordPos - plan.wordPos : 0,
      morphGlosses: unaligned ? file.morphGlosses - plan.morphGlosses : 0,
      morphPos: unaligned ? file.morphPos - plan.morphPos : 0,
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
            `${allowed ? ` (${allowed} reported as unaligned)` : ''}, ${lostInBuild} unaccounted for`,
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
