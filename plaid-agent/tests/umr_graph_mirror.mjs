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
// And three small documents of names the readers must agree on (`NAMES`): two
// nodes of one sentence storing one name, names that differ only in case, and
// the held relations of a graph kept as text after the open's repair dropped
// one naming a deleted node and renumbered another node to its name.
//
// argv[2] is a JSON array of .umr paths. Writes one object per variant to
// stdout: `{name, raw, sentences: [{roots, penman, order}]}`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, '../../plaid-umr');
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { layersOf, mergeSentence, openInUmr } = await import(`${UMR}/test/igtEdits.js`);

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

const SEP = '#'.repeat(80);
const block = (n, words, graph, alignment, doc = `(s${n}s0 / sentence)`) => `${SEP}
# :: snt${n}
Index: ${words.map((_, i) => i + 1).join(' ')}
Words: ${words.join(' ')}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
${doc}
`;
const person = (n, w, v) =>
  block(n, [w, 'gitti', '.'], `(s${n}g / git-01\n    :ARG1 (${v} / person))`, `s${n}g: 2-2\n${v}: 1-1`);
const spanOf = (raw, v) => layersOf(raw).concepts.spans.find((x) => x.metadata?.umr?.var === v);
const NAMES = [
  // Two nodes of one sentence storing one name.
  [
    'one name twice in a sentence',
    [person(1, 'Ali', 's1p'), person(2, 'Ayse', 's2p')],
    (raw) => {
      spanOf(raw, 's2g').metadata.umr.var = 's2p';
    },
  ],
  // Unaligned names that differ only in case, tied at the sentence start.
  [
    'names differing in case',
    [
      block(
        1,
        ['Ali', 'geldi', '.'],
        '(s1g / and\n    :op1 (s1B / thing)\n    :op2 (s1a / thing))',
        's1g: 2-2\ns1B: 0-0\ns1a: 0-0',
      ),
    ],
    () => {},
  ],
  // Sentence 3's graph does not parse, so it is kept as text and its block's
  // relations are held by name. An API writer deletes s2p, IGT joins
  // sentence 2 to 1, and the open renumbers sentence 2's person to s2p and
  // drops the relation naming the deleted one (REV-FIX7 L1, L2).
  [
    'held relations after a deleted node and a renumber',
    [
      person(1, 'Ali', 's1p'),
      person(2, 'Ayse', 's2p'),
      person(3, 'Can', 's3p'),
      block(
        4,
        ['O', 'uyudu', '.'],
        '(s4g / uyu-01\n    :ARG1 (s4x / "person)',
        's4g: 2-2',
        '(s4s0 / sentence\n    :coref ((s4x :same-entity s3p)\n        (s4x :subset-of s2p)))',
      ),
    ],
    async (raw) => {
      const { concepts, relations } = layersOf(raw);
      const gone = spanOf(raw, 's2p').id;
      concepts.spans = concepts.spans.filter((x) => x.id !== gone);
      relations.relations = relations.relations.filter(
        (r) => r.source !== gone && r.target !== gone,
      );
      mergeSentence(raw, 2);
      await openInUmr(raw);
    },
  ],
];

const sentencesOf = (doc) =>
  doc.sentences.map((s, i) => ({
    roots: s.roots.map((r) => r.var),
    penman: doc.penmanOf(i + 1),
    order: s.nodes.map((n) => n.var),
    held: s.held,
  }));

const out = [];
for (const [name, blocks, edit] of NAMES) {
  const raw = rawFromPlan(planImport(parseUmrFile(blocks.join('\n')).sentences, []));
  await edit(raw);
  out.push({ name: `names: ${name}`, raw: toPython(raw), sentences: sentencesOf(new UmrDocument({ raw })) });
}
for (const file of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  const parsed = parseUmrFile(readFileSync(file, 'utf8'));
  for (const [drop, unmark] of VARIANTS) {
    const plan = planImport(parsed.sentences, []);
    if (drop) plan.edges = plan.edges.filter((_, i) => i % drop !== 1);
    if (unmark) plan.nodes.forEach((n) => n.meta && delete n.meta.root);
    const raw = rawFromPlan(plan);
    const doc = new UmrDocument({ raw });
    out.push({
      name: `${basename(file)} drop ${drop}${unmark ? ' unmarked' : ''}`,
      raw: toPython(raw),
      sentences: sentencesOf(doc),
    });
  }
}
process.stdout.write(JSON.stringify(out));
