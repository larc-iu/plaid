// plaid-umr's own reading of a stored UMR document, run over the released
// sample files test_umr_graph_mirror.py names, so the Python reading in
// plaid_client.workflows.umr can be held to it sentence by sentence: each
// sentence's roots, in order, and `UmrDocument.penmanOf`, the text the Compare
// tab and text mode print.
//
// Each file is imported with the app's own import plan and laid out as the
// Python client hands a document back. Variants drop some of the edges (so a
// sentence falls into parts) and the file's root marks (so the roots are
// derived), which is how a graph looks while someone is building it.
//
// One more variant has the edits another app makes to the shared sentences
// and words (`igtEdited`), which the reader reads right before a UMR write
// stores it.
//
// argv[2] is a JSON array of .umr paths. Writes one object per variant to
// stdout: `{name, raw, sentences: [{roots, penman, alignment, held}]}`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, '../../plaid-umr');
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { insertSentenceAtStart } = await import(`${UMR}/test/igtInsertSentence.js`);
const { deleteWord, splitWord, wordsOf } = await import(`${UMR}/test/igtEdits.js`);

// The layer tree's own keys, as the Python client hands them back. What is
// under `metadata` and `config` is opaque to both clients.
const LAYER_KEYS = {
  textLayers: 'text_layers',
  tokenLayers: 'token_layers',
  spanLayers: 'span_layers',
  relationLayers: 'relation_layers',
};
const toPython = (value) => {
  if (Array.isArray(value)) return value.map(toPython);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[LAYER_KEYS[key] ?? key] =
      key === 'metadata' || key === 'config' ? inner : toPython(inner);
  }
  return out;
};

const VARIANTS = [
  [0, false],
  [3, false],
  [0, true],
  [2, true],
  [4, true],
];

// What another app's edits leave for the reader to read right before any
// UMR write stores it (umrSettle.js): a sentence typed in before the first
// (every variable's number moves), every seventh word split in two after
// its first letter, and every eleventh deleted under its node.
function igtEdited(raw) {
  insertSentenceAtStart(raw);
  wordsOf(raw).forEach((w, i) => {
    if (i % 11 === 5) deleteWord(raw, w.id);
    else if (i % 7 === 3 && w.end - w.begin > 1) splitWord(raw, w.id, w.begin + 1);
  });
  return raw;
}

const out = [];
for (const file of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  const parsed = parseUmrFile(readFileSync(file, 'utf8'));
  for (const [drop, unmark, edited] of [...VARIANTS, [0, false, true]]) {
    const plan = planImport(parsed.sentences, []);
    if (drop) plan.edges = plan.edges.filter((_, i) => i % drop !== 1);
    if (unmark) plan.nodes.forEach((n) => n.meta && delete n.meta.root);
    const raw = edited ? igtEdited(rawFromPlan(plan)) : rawFromPlan(plan);
    const doc = new UmrDocument({ raw });
    out.push({
      name: `${basename(file)} drop ${drop}${unmark ? ' unmarked' : ''}${edited ? ' edited' : ''}`,
      raw: toPython(raw),
      sentences: doc.sentences.map((s, i) => ({
        roots: s.roots.map((r) => r.var),
        penman: doc.penmanOf(i + 1),
        alignment: Object.fromEntries(s.nodes.map((n) => [n.var, n.alignment])),
        held: s.held,
      })),
    });
  }
}
process.stdout.write(JSON.stringify(out));
