// plaid-ud's own sentence split and enhanced graph, run over the documents
// test_enhanced_mirror.py generates, so the ud assistant's Python copies of
// both can be compared with them.
//
// Reads a cases JSON path as argv[2] and writes one result object per case to
// stdout. Each document is opened as the editor opens it (a ConlluDocument
// over the raw document), and each answer comes from the code the editor runs:
// DEPS from the CoNLL-U export, the suppressor over a basic relation from
// `suppressorFor`, and a split or merge from `toggleSentenceBoundary` against a
// stub client that records what it would send.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const UD = resolve(dirname(fileURLToPath(import.meta.url)), '../../plaid-ud');
const { ConlluDocument } = await import(`${UD}/src/domain/ConlluDocument.js`);
const { suppressorFor } = await import(`${UD}/src/domain/enhancedGraph.js`);
const { withOps } = await import(`${UD}/test/helpers/stubClient.js`);

// The DEPS column of every word row, per sentence. A range line (`1-2`) is a
// surface token, not a word, and carries no DEPS.
const depsBySentence = (conllu) => {
  const out = [];
  let current = null;
  for (const line of conllu.split('\n')) {
    if (line.startsWith('# sent_id')) {
      current = [];
      out.push(current);
    } else if (line && !line.startsWith('#') && current) {
      const cols = line.split('\t');
      if (!cols[0].includes('-')) current.push(cols[8]);
    }
  }
  return out;
};

// What one toggle at `charPos` sends, from a fresh document.
const toggle = async (raw, charPos) => {
  const sent = [];
  const client = withOps({
    tokens: {
      split: async (id, pos) => {
        sent.push(['split', id, pos]);
        return { id: 'new-sentence' };
      },
      merge: async (a, b) => {
        sent.push(['merge', a, b]);
        return {};
      },
    },
    relations: {
      delete: async (id) => {
        sent.push(['delete', id]);
        return {};
      },
    },
  });
  const doc = new ConlluDocument({ raw: structuredClone(raw), client });
  await doc.toggleSentenceBoundary(charPos);
  return sent;
};

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const c of cases) {
  const doc = new ConlluDocument({ raw: structuredClone(c.raw) });
  const info = doc.layerInfo;
  const rows = info.enhancedRelationLayer?.relations || [];
  const suppressorOf = {};
  for (const rel of info.relationLayer?.relations || []) {
    const s = suppressorFor(rel, rows);
    if (s) suppressorOf[rel.target] = s.id;
  }
  const splits = {};
  for (const pos of c.splitAt) splits[pos] = await toggle(c.raw, pos);
  const merges = {};
  for (const pos of c.mergeAt) merges[pos] = await toggle(c.raw, pos);
  out.push({
    deps: depsBySentence(doc.toConllu()),
    hasEnhanced: doc.sentences.map((s) => (s.enhancedRelations || []).length > 0),
    suppressorOf,
    splits,
    merges,
  });
}
process.stdout.write(JSON.stringify(out));
