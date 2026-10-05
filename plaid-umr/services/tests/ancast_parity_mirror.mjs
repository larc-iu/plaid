// The app's export of every released UMR sample in test/fixtures/umr, as
// imported and as an annotator or IGT changes it, for test_umr_ancast_parity.py
// to hold the AnCast writer's file to, byte for byte. The Compare tab scores
// what that writer makes, so it must be the file the Export tab gives.
//
// Each sample gives these cases, each changed as the app or IGT changes it
// and not yet healed by opening it in the app, which is how a service reads
// it:
//   imported   the file as the app's import lays it down (a graph the parser
//              cannot read is kept as text, with the relations held on it)
//   fragment   one leaf edge deleted in the first sentence with an edge, so
//              the leaf is a second graph the export leaves out
//   selfloop   a `:quote` edge from that sentence's root to itself
//   joined     sentences 1 and 2 joined, as IGT's Merge does: two graphs in
//              one sentence, the export writing the first one's
//   split      sentence 1 split between two of its words, as IGT does
//
// The gloss lines are taken off each sentence's record first. The AnCast
// writer writes Index and Words only (AnCast reads no gloss line), and the
// two files are otherwise compared whole.
//
// Writes `[{name, raw, expected}]` to stdout, `raw` laid out as the Python
// client's `documents.get(id, include_body=True)` hands a document back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UMR = path.resolve(HERE, '..', '..');
const SAMPLES = path.join(UMR, 'test', 'fixtures', 'umr');
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { layersOf, mergeSentence, sentencesOf, splitSentenceAt, wordsOf } = await import(
  `${UMR}/test/igtEdits.js`
);

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
    out[LAYER_KEYS[key] ?? key] = key === 'metadata' || key === 'config' ? inner : toPython(inner);
  }
  return out;
};

// Every record without its gloss lines.
function withoutGlossLines(raw) {
  layersOf(raw).nodes.tokens.forEach((t) => {
    if (t.metadata?.umr && typeof t.metadata.umr === 'object') delete t.metadata.umr.ilg;
  });
  return raw;
}

const fromText = (text) =>
  withoutGlossLines(rawFromPlan(planImport(parseUmrFile(text).sentences, [])));

// The spans and in-sentence edges of the first sentence that has an edge.
function firstSentence(raw) {
  const L = layersOf(raw);
  const tokens = new Map(L.nodes.tokens.map((t) => [t.id, t]));
  const begin = (span) => Math.min(...span.tokens.map((t) => tokens.get(t)?.begin ?? Infinity));
  for (const s of sentencesOf(raw)) {
    const spans = L.concepts.spans.filter((sp) => {
      const b = begin(sp);
      return b >= s.begin && b < s.end;
    });
    const ids = new Set(spans.map((sp) => sp.id));
    const edges = L.relations.relations.filter((r) => ids.has(r.source) && ids.has(r.target));
    if (edges.length) return { L, spans, edges };
  }
  return { L, spans: [], edges: [] };
}

// One edge into a node with no edges of its own, deleted.
function fragment(raw) {
  const { L, edges } = firstSentence(raw);
  const sources = new Set(edges.map((e) => e.source));
  const leaf = edges.find((e) => !sources.has(e.target) && e.source !== e.target);
  if (!leaf) return false;
  L.relations.relations = L.relations.relations.filter((r) => r !== leaf);
  return true;
}

// A `:quote` edge from the root to itself.
function selfLoop(raw) {
  const { L, spans, edges } = firstSentence(raw);
  const root = spans.find((sp) => sp.metadata?.umr?.root);
  if (!root) return false;
  const order =
    1 +
    Math.max(
      0,
      ...edges.filter((e) => e.source === root.id).map((e) => e.metadata?.umr?.order ?? 0),
    );
  L.relations.relations.push({
    id: 'fx4-self',
    source: root.id,
    target: root.id,
    value: ':quote',
    metadata: { umr: { order } },
  });
  return true;
}

// Sentence 1 split before its middle word.
function split(raw) {
  const s = sentencesOf(raw)[0];
  const words = wordsOf(raw).filter((w) => w.begin >= s.begin && w.end <= s.end);
  if (words.length < 2) return false;
  return splitSentenceAt(raw, words[Math.floor(words.length / 2)].begin);
}

const CASES = {
  imported: () => true,
  fragment,
  selfloop: selfLoop,
  joined: (raw) => {
    if (sentencesOf(raw).length < 2) return false;
    mergeSentence(raw, 2);
    return true;
  },
  split,
};

const out = [];
for (const file of fs
  .readdirSync(SAMPLES)
  .filter((f) => f.endsWith('.umr'))
  .sort()) {
  const text = fs.readFileSync(path.join(SAMPLES, file), 'utf8');
  const sample = file.replace(/\.umr$/, '');
  for (const [name, change] of Object.entries(CASES)) {
    const raw = fromText(text);
    if (!change(raw)) continue;
    // The document the export is taken from gets its own copy: the model may
    // keep references into what it was given.
    const expected = new UmrDocument({ raw: structuredClone(raw) }).toUmr();
    out.push({ name: `${sample}/${name}`, raw: toPython(raw), expected });
  }
}
process.stdout.write(JSON.stringify(out));
