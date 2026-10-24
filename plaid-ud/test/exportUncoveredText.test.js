// HUNT-udumr 2: igt leaves punctuation out of its words (the ignored-token
// rule), so a document it made has text no token covers. The rows cannot
// spell it, `# text` is the sentence's text, and a UD validator refuses the
// file. The Export tab says so, and how to fill the gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = the dog, barks',
  '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\t_\t4\tnsubj\t_\tSpaceAfter=No',
  '3\t,\t,\tPUNCT\t_\t_\t4\tpunct\t_\t_',
  '4\tbarks\tbark\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

// The document with the comma's token and word taken away, as igt makes it.
const withoutComma = () => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  const body = [...raw.textLayers[0].text.body];
  const comma = (t) => body.slice(t.begin, t.end).join('') === ',';
  const gone = new Set();
  for (const layer of raw.textLayers[0].tokenLayers) {
    if (layer.config?.plaid?.role === 'sentence') continue;
    for (const t of layer.tokens || []) if (comma(t)) gone.add(t.id);
    layer.tokens = (layer.tokens || []).filter((t) => !gone.has(t.id));
  }
  for (const layer of raw.textLayers[0].tokenLayers) {
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

test('text in no token is named on the Export tab', () => {
  const doc = new ConlluDocument({ raw: withoutComma() });
  assert.deepEqual(doc.conlluLosses(), [
    'Sentence 1 has text in no token (“,”), so its # text line does not match its rows. ' +
      'Tokenize in the Text Editor to give that text tokens.',
  ]);
});

test('a sentence whose tokens cover its text says nothing', () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'd1') });
  assert.deepEqual(doc.conlluLosses(), []);
});
