// The Text Editor's save when the stored text has moved on since the draft
// was typed (V3 H3-2): the draft's changes go onto the stored text, and a
// draft that changed the same passage is refused, never sent over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = ['# text = the big dog ran', '1\tthe big dog ran\t_\t_\t_\t_\t0\troot\t_\t_'].join(
  '\n',
);

const withBody = (raw, body) => {
  const next = structuredClone(raw);
  const layer = next.textLayers.find((l) => l.text);
  layer.text.body = body;
  return next;
};

const conflict = () =>
  Object.assign(new Error('HTTP 409 changed since at http://x/api/v1/texts/text-1'), {
    status: 409,
    method: 'PATCH',
  });

function setup({ stored, answers = [] }) {
  const raw = rawDocFromConllu(INPUT, 'text-doc');
  const base = raw.textLayers.find((l) => l.text).text.body;
  const sent = [];
  const client = withOps({
    texts: {
      update: async (_id, body) => {
        sent.push(body);
        const answer = answers.shift();
        if (answer) throw answer;
        return {};
      },
    },
    documents: { get: async () => withBody(raw, stored ?? base) },
  });
  return { doc: new ConlluDocument({ raw, client }), base, sent };
}

test('a save refused as out of date is merged onto the refetched text and sent again', async () => {
  const { doc, base, sent } = setup({ stored: 'the dog ran', answers: [conflict()] });
  let stored = null;
  const ok = await doc.saveText(`${base} home`, { base, onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.deepEqual(sent, [`${base} home`, 'the dog ran home']);
  assert.equal(stored, 'the dog ran home');
});

test('a draft that changed the same passage is refused and not sent over the stored text', async () => {
  const { doc, base, sent } = setup({ stored: 'the huge dog ran', answers: [conflict()] });
  const ok = await doc.saveText('the large dog ran', { base });
  assert.equal(ok, false);
  assert.deepEqual(sent, ['the large dog ran']);
  assert.match(doc.error, /same passage was changed elsewhere/);
});

test('a copy that already holds a newer text merges before the first send', async () => {
  const { doc, sent } = setup({});
  const base = 'the big dog ran';
  doc._raw = withBody(doc._raw, 'the dog ran');
  doc._dataVersion += 1;
  assert.equal(await doc.saveText(`${base} home`, { base }), true);
  assert.deepEqual(sent, ['the dog ran home']);
});
