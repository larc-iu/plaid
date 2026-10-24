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
import { DOC_CONSTANTS } from '../src/domain/format/inventory.js';
import { rawFromPlan } from './rawFromPlan.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');

const graphShape = (graph, as = (v) => v) => {
  if (!graph?.root) return null;
  const nodes = {};
  graph.nodes.forEach((node, v) => {
    nodes[as(v)] = {
      concept: node.concept,
      // Not `inline`: a file may expand a re-entrant node at a later mention
      // than its first (a forward reference, which the official validator
      // rejects), and the export always expands at the first.
      children: node.children.map((c) => [
        c.rel,
        c.kind,
        c.kind === 'node' ? as(c.value) : c.value,
      ]),
    };
  });
  return { root: as(graph.root), nodes };
};

// The names the reader gives a file's variables whose sentence number is not
// their sentence's (sentenceGraph.js renumberMoves), as the export writes
// them: by sentence, and over the document where only one node was so named.
const readNames = (doc) => {
  const bySentence = new Map();
  const everywhere = new Map();
  doc.graph.nodesById.forEach((n) => {
    if (!n.storedVar || n.storedVar === n.var) return;
    if (!bySentence.has(n.sentence)) bySentence.set(n.sentence, new Map());
    bySentence.get(n.sentence).set(n.storedVar, n.var);
    everywhere.set(n.storedVar, everywhere.has(n.storedVar) ? null : n.var);
  });
  return {
    in: (index) => (v) => bySentence.get(index)?.get(v) ?? v,
    any: (v) => everywhere.get(v) || v,
  };
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
    const named = readNames(doc);
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
      const as = named.in(i + 1);
      assert.deepEqual(graphShape(a.graph), graphShape(o.graph, as), `sentence ${i + 1} graph`);
      // A file may omit its alignment block (the release data does); the
      // export then lists every node as unaligned, which is what the spec
      // requires and what omission meant.
      const alignments = (s, rename = (v) => v) =>
        Object.fromEntries([...s.alignment].map(([v, r]) => [rename(v), JSON.stringify(r)]));
      const oAlign = alignments(o, as);
      const aAlign = alignments(a);
      Object.keys(aAlign).forEach((v) => {
        if (!(v in oAlign)) assert.equal(aAlign[v], '[]', `sentence ${i + 1} ${v} unaligned`);
      });
      Object.keys(oAlign).forEach((v) => {
        // An alignment for a variable the graph never defines is dropped.
        if (![...o.graph.nodes.keys()].some((k) => as(k) === v)) return;
        assert.equal(aAlign[v], oAlign[v], `sentence ${i + 1} ${v} alignment`);
      });
    });
    assert.ok(compared > 0, 'nothing compared');

    // Triples as a document-wide set: duplicates and order are the file's,
    // and a triple a file writes in a later sentence than the two it joins
    // (the validator's "misplaced") is written where it belongs. A triple
    // naming a variable no sentence defines is dropped on import. One naming
    // a variable of a graph kept as text is held and written back (the
    // owner's ruling of 2026-09-28), so that graph's variables count, read
    // here apart from the app's own reading.
    const defined = new Set(DOC_CONSTANTS);
    original.sentences.forEach((s) => {
      if (readable(s)) s.graph.nodes.forEach((_, v) => defined.add(v));
      else if (s.raw?.graph) {
        for (const m of s.raw.graph.matchAll(/\(\s*(s[0-9]+[^\s/()]*)\s*\//g)) defined.add(m[1]);
      }
    });
    const setOf = (sentences) =>
      [...new Set(sentences.flatMap((s) => tripleSet(s.docGraph)))].sort();
    const known = setOf(original.sentences)
      .filter((t) =>
        t
          .split(' ')
          .slice(1)
          .filter((x) => !x.startsWith(':'))
          .every((x) => defined.has(x)),
      )
      .map((t) =>
        t
          .split(' ')
          .map((x, k) => (k === 0 || x.startsWith(':') ? x : named.any(x)))
          .join(' '),
      )
      .sort();
    assert.deepEqual(setOf(again.sentences), known, 'document graph');
  });
}
