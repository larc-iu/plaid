// LP2-4: a sentence that holds no tokens (one igt or a plain-text import made
// before anyone tokenized it) has no rows, so the CoNLL-U file leaves it out.
// Kalamang_v3 lost 675 of 16,810 that way with nothing said. The Export tab
// counts them and says how to give them tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = the dog',
  '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\t_\t0\troot\t_\t_',
  '',
  '# text = barks',
  '1\tbarks\tbark\tVERB\t_\t_\t0\troot\t_\t_',
  '',
  '# text = runs',
  '1\truns\trun\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

// The document with every token after the first sentence taken away, its
// sentences kept.
const emptyAfterFirst = () => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  const layers = raw.textLayers[0].tokenLayers;
  const sentences = layers.find((l) => l.config?.plaid?.role === 'sentence').tokens;
  const firstEnd = Math.min(...sentences.map((s) => s.end));
  const gone = new Set();
  for (const layer of layers) {
    if (layer.config?.plaid?.role === 'sentence') continue;
    for (const t of layer.tokens || []) if (t.begin >= firstEnd) gone.add(t.id);
    layer.tokens = (layer.tokens || []).filter((t) => !gone.has(t.id));
  }
  for (const layer of layers) {
    for (const sl of layer.spanLayers || []) {
      const spans = new Set(
        (sl.spans || []).filter((s) => s.tokens.some((t) => gone.has(t))).map((s) => s.id),
      );
      sl.spans = (sl.spans || []).filter((s) => !spans.has(s.id));
      for (const rl of sl.relationLayers || []) {
        rl.relations = (rl.relations || []).filter(
          (r) => !spans.has(r.source) && !spans.has(r.target),
        );
      }
    }
  }
  return raw;
};

test('sentences with no tokens are counted on the Export tab', () => {
  const doc = new ConlluDocument({ raw: emptyAfterFirst() });
  assert.equal(doc.sentences.length, 1);
  assert.deepEqual(doc.conlluLosses(), [
    '2 sentences hold no tokens and are not in the file. ' +
      'Tokenize in the Text Editor to give them tokens.',
  ]);
});

test('every sentence holding tokens says nothing', () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'd1') });
  assert.deepEqual(doc.conlluLosses(), []);
});
