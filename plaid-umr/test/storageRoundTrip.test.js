// The round trip through the STORAGE model: a .umr file planned for import,
// laid into a raw document the way the server would return it, read back by
// UmrDocument and written out again. The format layer's own round trip
// (parse, serialize, parse) cannot see a bug in how graphs are kept as spans
// and relations, and the first one it missed was a sentence whose root has a
// :quote edge into it, exported from the wrong node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { UMR_NAMESPACE } from '../src/utils/umrLayerUtils.js';
import { DOC_CONSTANTS } from '../src/domain/format/inventory.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');

// What planImport writes, as the server would hand it back.
export function rawFromPlan(plan) {
  let n = 0;
  const id = () => `id${++n}`;
  const textId = id();
  const sentenceTokens = plan.sentences.map((s) => ({
    id: id(),
    begin: s.begin,
    end: s.end,
    metadata: { [UMR_NAMESPACE]: s.meta },
  }));
  const wordTokens = plan.sentences.flatMap((s) =>
    s.words.map((w) => ({ id: id(), begin: w.begin, end: w.end })),
  );
  const pieceTokens = plan.pieces.map((p) => ({ id: id(), begin: p.begin, end: p.end }));
  const spans = plan.nodes.map((node) => ({
    id: id(),
    tokens: node.pieceIndexes.map((i) => pieceTokens[i].id),
    value: node.concept,
    metadata: { [UMR_NAMESPACE]: node.meta },
  }));
  const spanOf = (key) => spans[plan.nodeIndex.get(key)].id;
  const relations = plan.edges.map((e) => ({
    id: id(),
    source: spanOf(e.source),
    target: spanOf(e.target),
    value: e.role,
    metadata: { [UMR_NAMESPACE]: { order: e.order } },
  }));
  const triples = plan.triples.map((t) => ({
    id: id(),
    source: spanOf(t.source),
    target: spanOf(t.target),
    value: t.rel,
    metadata: { [UMR_NAMESPACE]: t.meta },
  }));
  const role = (r) => ({ plaid: { role: r } });
  return {
    id: 'doc',
    name: 'doc',
    textLayers: [
      {
        id: id(),
        config: role('baseline'),
        text: { id: textId, body: plan.body },
        tokenLayers: [
          { id: id(), config: role('sentence'), tokens: sentenceTokens, spanLayers: [] },
          { id: id(), config: role('word'), tokens: wordTokens, spanLayers: [] },
          {
            id: id(),
            config: { [UMR_NAMESPACE]: { nodes: true } },
            tokens: pieceTokens,
            spanLayers: [
              {
                id: id(),
                config: { [UMR_NAMESPACE]: { concepts: true } },
                spans,
                relationLayers: [
                  { id: id(), config: { [UMR_NAMESPACE]: { relations: true } }, relations },
                  {
                    id: id(),
                    config: { [UMR_NAMESPACE]: { documentGraph: true } },
                    relations: triples,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const graphShape = (graph) => {
  if (!graph?.root) return null;
  const nodes = {};
  graph.nodes.forEach((node, v) => {
    nodes[v] = {
      concept: node.concept,
      // Not `inline`: a file may expand a re-entrant node at a later mention
      // than its first (a forward reference, which the official validator
      // rejects), and the export always expands at the first.
      children: node.children.map((c) => [c.rel, c.kind, c.value]),
    };
  });
  return { root: graph.root, nodes };
};

const tripleSet = (dg) =>
  dg
    ? ['temporal', 'modal', 'coref']
        .flatMap((g) => (dg[g] || []).map((t) => `${g} ${t.join(' ')}`))
        .sort()
    : [];

for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.umr'))) {
  test(`${file} survives the storage model`, () => {
    const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    const original = parseUmrFile(text);
    const plan = planImport(original.sentences, []);
    const doc = new UmrDocument({ raw: rawFromPlan(plan) });
    const again = parseUmrFile(doc.toUmr());
    // A graph the parser could not read is kept as text, so its errors come
    // back as they went in. Any other sentence must be clean.
    const readable = (s) => s.graph && !s.graph.errors.length;
    const brokenBefore = new Set(
      original.sentences.filter((s) => s.graph && !readable(s)).map((s) => s.index),
    );
    const fresh = again.errors.filter((e) => !brokenBefore.has(e.sentence));
    assert.equal(fresh.length, 0, JSON.stringify(fresh.slice(0, 3)));
    assert.equal(again.sentences.length, original.sentences.length);
    let compared = 0;
    original.sentences.forEach((o, i) => {
      compared++;
      const a = again.sentences[i];
      if (!readable(o)) {
        // Verbatim: the same graph text, the same errors.
        if (o.graph) assert.equal(a.raw.graph, o.raw.graph, `sentence ${i + 1} raw graph`);
        return;
      }
      assert.deepEqual(a.words, o.words, `sentence ${i + 1} words`);
      assert.deepEqual(graphShape(a.graph), graphShape(o.graph), `sentence ${i + 1} graph`);
      // A file may omit its alignment block (the release data does); the
      // export then lists every node as unaligned, which is what the spec
      // requires and what omission meant.
      const alignments = (s) =>
        Object.fromEntries([...s.alignment].map(([v, r]) => [v, JSON.stringify(r)]));
      const oAlign = alignments(o);
      const aAlign = alignments(a);
      Object.keys(aAlign).forEach((v) => {
        if (!(v in oAlign)) assert.equal(aAlign[v], '[]', `sentence ${i + 1} ${v} unaligned`);
      });
      Object.keys(oAlign).forEach((v) => {
        // An alignment for a variable the graph never defines is dropped.
        if (!o.graph.nodes.has(v)) return;
        assert.equal(aAlign[v], oAlign[v], `sentence ${i + 1} ${v} alignment`);
      });
    });
    assert.ok(compared > 0, 'nothing compared');

    // Triples as a document-wide set: duplicates and order are the file's,
    // and a triple a file writes in a later sentence than the two it joins
    // (the validator's "misplaced") is written where it belongs. A triple
    // naming a variable no readable sentence defines is dropped on import.
    const defined = new Set(DOC_CONSTANTS);
    original.sentences
      .filter(readable)
      .forEach((s) => s.graph.nodes.forEach((_, v) => defined.add(v)));
    const setOf = (sentences) =>
      [...new Set(sentences.flatMap((s) => tripleSet(s.docGraph)))].sort();
    const known = setOf(original.sentences).filter((t) =>
      t
        .split(' ')
        .slice(1)
        .filter((x) => !x.startsWith(':'))
        .every((x) => defined.has(x)),
    );
    assert.deepEqual(setOf(again.sentences), known, 'document graph');
  });
}
