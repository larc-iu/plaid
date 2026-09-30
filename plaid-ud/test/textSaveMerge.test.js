// The Text Editor's save: the edits typed in the box go as their net change
// over the body they were typed on (PATCH /texts/:id with `edits` and
// `base`). When the stored text has moved on since (V3 H3-2), the edits are
// moved onto it, and a draft that changed the same passage is refused, never
// sent over it. The answer's reshape is put on screen in place of a refetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTextOps } from '@larc-iu/plaid-client';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { recordEdit, startEditLog } from '../../plaid-ui/src/lib/editLog.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = the big dog ran',
  '1\tthe\t_\t_\t_\t_\t0\troot\t_\t_',
  '2\tbig\t_\t_\t_\t_\t1\tamod\t_\t_',
  '3\tdog\t_\t_\t_\t_\t1\tnsubj\t_\t_',
  '4\tran\t_\t_\t_\t_\t1\tdep\t_\t_',
].join('\n');

const digestOf = (body) => `digest:${body}`;
const textOf = (raw) => raw.textLayers.find((l) => l.text).text;

const withBody = (raw, body) => {
  const next = structuredClone(raw);
  const text = textOf(next);
  text.body = body;
  text.digest = digestOf(body);
  return next;
};

const lostAnswer = () =>
  Object.assign(new Error('HTTP 502 Bad Gateway at http://x/api/v1/texts/text-1'), {
    status: 502,
    method: 'PATCH',
  });

// A server holding one body. `edit` refuses a stale base with 409 and
// `text-changed`, applies the ops otherwise and answers the text with a
// reshape. `onEdit(call)` may answer instead: a string is a new stored body
// written by someone else just before the edit arrives, an error is thrown
// after the edit is applied (a lost answer).
function setup({ stored, onEdit = () => null } = {}) {
  const raw = withBody(rawDocFromConllu(INPUT, 'text-doc'), 'the big dog ran');
  const base = textOf(raw).body;
  const server = { body: stored ?? base, reads: 0 };
  const sent = [];
  const client = withOps({
    texts: {
      edit: async (id, ops, _message, { base: digest } = {}) => {
        const call = { id, ops, digest };
        sent.push(call);
        const answer = onEdit(call, sent.length);
        if (typeof answer === 'string') server.body = answer;
        if (digest !== digestOf(server.body)) {
          throw Object.assign(new Error('HTTP 409 The text was changed since it was read.'), {
            status: 409,
            method: 'PATCH',
            responseData: { 'text-changed': true, digest: digestOf(server.body) },
          });
        }
        server.body = applyTextOps(server.body, ops);
        if (answer instanceof Error) throw answer;
        return {
          id,
          body: server.body,
          digest: digestOf(server.body),
          reshape: { tokens: [], spans: [], vocabLinks: [], deleted: {} },
        };
      },
    },
    documents: {
      get: async () => {
        server.reads += 1;
        return withBody(raw, server.body);
      },
    },
  });
  const doc = new ConlluDocument({ raw, client });
  const text = textOf(raw);
  return { doc, base, server, sent, text };
}

// The gaps that turn `base` into `mine`, as the Text Editor's log sends them.
const edited = (base, mine) =>
  recordEdit(startEditLog(base, digestOf(base)), base, null, mine, null);

test('a save sends the edits with the digest of the body they were typed on', async () => {
  const { doc, base, sent, server } = setup();
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), {
    onStored: (body, digest) => (stored = { body, digest }),
  });
  assert.equal(ok, true);
  assert.deepEqual(sent, [
    { id: 'text-1', ops: [{ type: 'insert', index: 15, value: ' home' }], digest: digestOf(base) },
  ]);
  assert.deepEqual(stored, { body: `${base} home`, digest: digestOf(`${base} home`) });
  // The answer is on screen: no refetch.
  assert.equal(doc.body, `${base} home`);
  assert.equal(textOf(doc._raw).digest, digestOf(`${base} home`));
  assert.equal(server.reads, 0);
});

test('a save refused as out of date is moved onto the refetched text and sent again', async () => {
  const { doc, base, sent } = setup({ onEdit: (_c, n) => (n === 1 ? 'the dog ran' : null) });
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].digest, digestOf('the dog ran'));
  assert.deepEqual(sent[1].ops, [{ type: 'insert', index: 11, value: ' home' }]);
  assert.equal(stored, 'the dog ran home');
  assert.equal(doc.body, 'the dog ran home');
});

test('a draft that changed the same passage is refused and not sent over the stored text', async () => {
  const { doc, base, sent, server } = setup({
    onEdit: (_c, n) => (n === 1 ? 'the huge dog ran' : null),
  });
  const ok = await doc.saveText(edited(base, 'the large dog ran'));
  assert.equal(ok, false);
  assert.equal(sent.length, 1);
  assert.equal(server.body, 'the huge dog ran');
  assert.match(doc.error, /same passage was changed elsewhere/);
});

test('a copy that already holds a newer text moves the edits before the first send', async () => {
  const { doc, base, sent } = setup({ stored: 'the dog ran' });
  doc._raw = withBody(doc._raw, 'the dog ran');
  doc._dataVersion += 1;
  assert.equal(await doc.saveText(edited(base, `${base} home`)), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].digest, digestOf('the dog ran'));
  assert.equal(doc.body, 'the dog ran home');
});

test('a save whose answer was lost and which landed is not sent again', async () => {
  const { doc, base, sent, server } = setup({
    onEdit: (_c, n) => (n === 1 ? lostAnswer() : null),
  });
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(server.body, `${base} home`);
  assert.equal(stored, `${base} home`);
  assert.equal(doc.body, `${base} home`);
});

test('a save whose answer was lost and which did not land is sent again', async () => {
  const { doc, base, sent, server } = setup();
  // The first send fails before the server applies it.
  const edit = doc._client.texts.edit;
  let first = true;
  doc._client.texts.edit = async (...args) => {
    if (first) {
      first = false;
      throw lostAnswer();
    }
    return edit(...args);
  };
  assert.equal(await doc.saveText(edited(base, `${base} home`)), true);
  assert.equal(sent.length, 1);
  assert.equal(server.body, `${base} home`);
});

test('the answer moves tokens and drops the rows the edit deleted', async () => {
  const { doc, base } = setup();
  const words = doc.layerInfo.wordTokenLayer.tokens;
  const [the, big] = words;
  doc._client.texts.edit = async (id, ops) => {
    const body = applyTextOps(base, ops);
    return {
      id,
      body,
      digest: digestOf(body),
      reshape: {
        tokens: words
          .filter((w) => w.begin > big.begin)
          .map((w) => ({ id: w.id, begin: w.begin - 4, end: w.end - 4 })),
        spans: [],
        vocabLinks: [],
        deleted: { tokens: [big.id], spans: [], relations: [], vocabLinks: [] },
      },
    };
  };
  assert.equal(await doc.saveText(edited(base, 'the dog ran')), true);
  const after = doc.layerInfo.wordTokenLayer.tokens;
  assert.deepEqual(
    after.map((w) => [w.id, w.begin, w.end]),
    [
      [the.id, 0, 3],
      [words[2].id, 4, 7],
      [words[3].id, 8, 11],
    ],
  );
  assert.equal(doc.body, 'the dog ran');
});

test('a document with no text saved creates it with the typed body', async () => {
  const raw = rawDocFromConllu(INPUT, 'text-doc');
  const layer = raw.textLayers.find((l) => l.text);
  layer.text = null;
  const created = [];
  const client = withOps({
    texts: {
      create: async (layerId, docId, body) => {
        created.push({ layerId, docId, body });
        return { id: 'text-new' };
      },
    },
    documents: { get: async () => raw },
  });
  const doc = new ConlluDocument({ raw, client });
  let stored = null;
  const ok = await doc.saveText(edited('', 'Hello.'), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.deepEqual(created, [{ layerId: layer.id, docId: raw.id, body: 'Hello.' }]);
  assert.equal(stored, 'Hello.');
});

test('a whole new body (for scripts) is sent as the stored body typed over', async () => {
  const { doc, base, sent } = setup();
  const ok = await doc.saveText('the big cat ran');
  assert.equal(ok, true);
  assert.deepEqual(sent, [
    {
      id: 'text-1',
      ops: [{ type: 'replace', index: 0, length: [...base].length, value: 'the big cat ran' }],
      digest: digestOf(base),
    },
  ]);
  assert.equal(doc.body, 'the big cat ran');
});
