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
// And a few small documents of names the readers must agree on (`NAMES`):
// held relations across a merge, a name a moved node shares with one that
// keeps it, two nodes of one sentence storing one name, and names that
// differ only in case.
//
// argv[2] is a JSON array of .umr paths. Writes one object per variant to
// stdout: `{name, raw, sentences: [{roots, penman, alignment, held, order}]}`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, "../../plaid-umr");
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { insertSentenceAtStart } = await import(
  `${UMR}/test/igtInsertSentence.js`
);
const { deleteWord, layersOf, mergeSentence, splitWord, wordsOf } =
  await import(`${UMR}/test/igtEdits.js`);

// The layer tree's own keys, as the Python client hands them back. What is
// under `metadata` and `config` is opaque to both clients.
const LAYER_KEYS = {
  textLayers: "text_layers",
  tokenLayers: "token_layers",
  spanLayers: "span_layers",
  relationLayers: "relation_layers",
};
const toPython = (value) => {
  if (Array.isArray(value)) return value.map(toPython);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[LAYER_KEYS[key] ?? key] =
      key === "metadata" || key === "config" ? inner : toPython(inner);
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
    else if (i % 7 === 3 && w.end - w.begin > 1)
      splitWord(raw, w.id, w.begin + 1);
  });
  return raw;
}

const SEP = "#".repeat(80);
const block = (
  n,
  words,
  graph,
  alignment,
  doc = `(s${n}s0 / sentence)`,
) => `${SEP}
# :: snt${n}
Index: ${words.map((_, i) => i + 1).join(" ")}
Words: ${words.join(" ")}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
${doc}
`;
const person = (n, w, v) =>
  block(
    n,
    [w, "gitti", "."],
    `(s${n}g / git-01\n    :ARG1 (${v} / person))`,
    `s${n}g: 2-2\n${v}: 1-1`,
  );
const KEPT = block(
  4,
  ["O", "uyudu", "."],
  '(s4g / uyu-01\n    :ARG1 (s4x / "person)',
  "s4g: 2-2",
  "(s4s0 / sentence\n    :coref ((s4x :same-entity s3p)\n        (s4x :subset-of s2p)\n        (s4x :same-entity s1p)))",
);
const unnumbered = (raw) => {
  layersOf(raw).nodes.tokens.forEach((t) => {
    if (t.metadata?.umr) delete t.metadata.umr.snt;
  });
  return raw;
};
const spanOf = (raw, v) =>
  layersOf(raw).concepts.spans.find((x) => x.metadata?.umr?.var === v);
const NAMES = [
  // Sentence 2 merged into 1: both persons move, and the held relations
  // follow them.
  [
    "held across a merge",
    [
      person(1, "Ali", "s1p"),
      person(2, "Ayse", "s2p"),
      person(3, "Can", "s3p"),
      KEPT,
    ],
    (raw) => mergeSentence(unnumbered(raw), 2),
  ],
  // As an older write left it: sentence 3's person stores s2p beside
  // sentence 2's, which moved into sentence 1. A held s2p names the one
  // that keeps it.
  [
    "a moved name another node keeps",
    [
      person(1, "Ali", "s1a"),
      person(2, "Ayse", "s2p"),
      person(3, "Can", "s3p"),
      KEPT,
    ],
    (raw) => {
      mergeSentence(unnumbered(raw), 2);
      spanOf(raw, "s3p").metadata.umr.var = "s2p";
    },
  ],
  // Two nodes of one sentence storing one name.
  [
    "one name twice in a sentence",
    [person(1, "Ali", "s1p"), person(2, "Ayse", "s2p")],
    (raw) => {
      unnumbered(raw);
      spanOf(raw, "s2g").metadata.umr.var = "s2p";
    },
  ],
  // Unaligned names that differ only in case, tied at the sentence start.
  [
    "names differing in case",
    [
      block(
        1,
        ["Ali", "geldi", "."],
        "(s1g / and\n    :op1 (s1B / thing)\n    :op2 (s1a / thing))",
        "s1g: 2-2\ns1B: 0-0\ns1a: 0-0",
      ),
    ],
    (raw) => unnumbered(raw),
  ],
];

const out = [];
const sentencesOf = (doc) =>
  doc.sentences.map((s, i) => ({
    roots: s.roots.map((r) => r.var),
    penman: doc.penmanOf(i + 1),
    alignment: Object.fromEntries(s.nodes.map((n) => [n.var, n.alignment])),
    held: s.held,
    order: s.nodes.map((n) => n.var),
  }));
for (const [name, blocks, edit] of NAMES) {
  const raw = rawFromPlan(
    planImport(parseUmrFile(blocks.join("\n")).sentences, []),
  );
  edit(raw);
  out.push({
    name: `names: ${name}`,
    raw: toPython(raw),
    sentences: sentencesOf(new UmrDocument({ raw })),
  });
}
for (const file of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
  const parsed = parseUmrFile(readFileSync(file, "utf8"));
  for (const [drop, unmark, edited] of [...VARIANTS, [0, false, true]]) {
    const plan = planImport(parsed.sentences, []);
    if (drop) plan.edges = plan.edges.filter((_, i) => i % drop !== 1);
    if (unmark) plan.nodes.forEach((n) => n.meta && delete n.meta.root);
    const raw = edited ? igtEdited(rawFromPlan(plan)) : rawFromPlan(plan);
    const doc = new UmrDocument({ raw });
    out.push({
      name: `${basename(file)} drop ${drop}${unmark ? " unmarked" : ""}${edited ? " edited" : ""}`,
      raw: toPython(raw),
      sentences: sentencesOf(doc),
    });
  }
}
process.stdout.write(JSON.stringify(out));
