// plaid-umr's own reading of a UMR document after IGT has added or moved a
// sentence, before the app heals it, so test_umr_sentence_mirror.py can hold
// the Python reading to it: the sentence each node is in, and what each
// sentence reads of its record (the file's `snt` number, gloss and metadata
// lines, a graph kept as text) and its block's triples.
//
// Each case is a small imported file, changed as IGT changes it:
//   prepend       a sentence typed in before the first and split off, which
//                 keeps the first sentence's token (and record, and the
//                 record of its unaligned node) on the new text
//   excerpt       the same over a file numbered from snt5
//   between       a sentence typed in between the first two
//   later         a boundary moved two characters later, over an unaligned
//                 node of the second sentence
//   outside       an unaligned node standing outside every sentence
//   gone          an unaligned node recording a sentence token that is gone
//
// Writes one object per case to stdout: `{name, raw, nodes: {var: sentence},
// sentences: [{snt, ilg, meta, rawGraph, triples}]}`.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, "../../plaid-umr");
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { insertSentenceAtStart } = await import(
  `${UMR}/test/igtInsertSentence.js`
);

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

const SEP = "#".repeat(80);
const block = (n, v = n) => `${SEP}
# :: snt${n}
Index: 1 2 3 4
Words: Ali kitap verdi .
Gloss: Ali book gave .

# sentence level graph:
(s${v}v / ver-01
    :ARG0 (s${v}a / person
        :name (s${v}n / name :op1 "Ali"))
    :ARG1 (s${v}k / kitap))

# alignment:
s${v}v: 3-3
s${v}a: 1-1
s${v}n: 0-0
s${v}k: 2-2

# document level annotation:
(s${v}s0 / sentence
    :modal ((root :modal author)))
`;
// A sentence the file leaves with no graph.
const bare = (n) => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: Veli uyudu .
Gloss: Veli slept .

# sentence level graph:


# alignment:


# document level annotation:
(s${n}s0 / sentence)
`;

const fromText = (text) =>
  rawFromPlan(planImport(parseUmrFile(text).sentences, []));
// A sentence added in IGT and annotated stores nothing on its token.
const added = (raw, i) => {
  delete role(raw, "sentence").tokens[i].metadata.umr;
};
const role = (raw, r) =>
  raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);
const nodeLayer = (raw) =>
  raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
const spanOf = (raw, v) =>
  nodeLayer(raw).spanLayers[0].spans.find((s) => s.metadata.umr.var === v);
const pieceOf = (raw, v) =>
  nodeLayer(raw).tokens.find((t) => t.id === spanOf(raw, v).tokens[0]);

// Text typed at the end of the first sentence and split off: every token
// after it moves along.
function insertAfterFirst(raw) {
  const layer = raw.textLayers[0];
  const at = role(raw, "sentence").tokens[0].end;
  const text = "Yeni cümle .\n";
  const shift = [...text].length;
  const body = [...layer.text.body];
  layer.text.body = [...body.slice(0, at), ...text, ...body.slice(at)].join("");
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t.begin >= at) {
        t.begin += shift;
        t.end += shift;
      }
    }),
  );
  role(raw, "sentence").tokens.push({
    id: "igt-mid",
    begin: at,
    end: at + shift,
  });
}

const CASES = {
  prepend: () => {
    const raw = fromText(`${block(1)}\n${block(2)}`);
    insertSentenceAtStart(raw);
    return raw;
  },
  excerpt: () => {
    const raw = fromText(`${block(5)}\n${block(6)}`);
    insertSentenceAtStart(raw);
    return raw;
  },
  between: () => {
    const raw = fromText(`${block(1)}\n${block(2)}\n${block(3)}`);
    insertAfterFirst(raw);
    return raw;
  },
  later: () => {
    const raw = fromText(`${block(1)}\n${block(2)}`);
    const [first, second] = role(raw, "sentence").tokens;
    first.end += 2;
    second.begin += 2;
    return raw;
  },
  outside: () => {
    const raw = fromText(`${block(1)}\n${block(2)}`);
    const piece = pieceOf(raw, "s2n");
    const end = [...raw.textLayers[0].text.body].length;
    piece.begin = end + 5;
    piece.end = end + 5;
    return raw;
  },
  // A sentence the file left bare, then one added in IGT and annotated,
  // named by its own position: the record stays (8a1d2d44), in an excerpt
  // numbered from 2 and after a sentence typed in before the first.
  bareExcerpt: () => {
    const raw = fromText(`${bare(2)}\n${block(3, 2)}`);
    added(raw, 1);
    return raw;
  },
  bareShifted: () => {
    const raw = fromText(`${block(1)}\n${bare(2)}\n${block(3)}`);
    added(raw, 2);
    insertSentenceAtStart(raw);
    return raw;
  },
  gone: () => {
    const raw = fromText(`${block(1)}\n${block(2)}`);
    spanOf(raw, "s2n").metadata.umr.sentence = "a-token-that-is-gone";
    return raw;
  },
};

const out = [];
for (const [name, make] of Object.entries(CASES)) {
  const raw = make();
  const doc = new UmrDocument({ raw });
  const nodes = {};
  doc.graph.nodesById.forEach((n) => {
    if (!n.constant) nodes[n.var] = n.sentence;
  });
  out.push({
    name,
    raw: toPython(raw),
    nodes,
    sentences: doc.graph.sentences.map((s) => ({
      snt: s.snt,
      text: s.text,
      ilg: s.storedIlg.map((l) => l.header),
      meta: s.meta,
      rawGraph: s.rawGraph,
      triples: s.triples.map((t) => t.rel).sort(),
    })),
  });
}
process.stdout.write(JSON.stringify(out));
