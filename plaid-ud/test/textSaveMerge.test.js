// The Text Editor's save: the edits typed in the box go as their net change
// over the body they were typed on (PATCH /texts/:id with `edits` and
// `base`). When the stored text has moved on since (V3 H3-2), the edits are
// moved onto it, and a draft that changed the same passage is refused, never
// sent over it. The answer's reshape is put on screen in place of a refetch.
// A request whose answer was lost goes again as it was, under its key, and is
// never moved onto a text that may already hold it (REV-edit-ops R10, R11).
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

// A doubled word, where a delete of one `the` reads the same as a delete of
// the other.
const DOUBLED = [
  '# text = I saw the the dog',
  '1\tI\t_\t_\t_\t_\t0\troot\t_\t_',
  '2\tsaw\t_\t_\t_\t_\t1\tdep\t_\t_',
  '3\tthe\t_\t_\t_\t_\t1\tdep\t_\t_',
  '4\tthe\t_\t_\t_\t_\t1\tdep\t_\t_',
  '5\tdog\t_\t_\t_\t_\t1\tdep\t_\t_',
].join('\n');

const digestOf = (body) => `digest:${body}`;
const textOf = (raw) => raw.textLayers.find((l) => l.text).text;

const withBody = (raw, body, digest = digestOf(body)) => {
  const next = structuredClone(raw);
  const text = textOf(next);
  text.body = body;
  text.digest = digest;
  return next;
};

const lostAnswer = () =>
  Object.assign(new Error('HTTP 502 Bad Gateway at http://x/api/v1/texts/text-1'), {
    status: 502,
    method: 'PATCH',
  });

// The client's operations with Idempotency-Keys, as plaid-client numbers
// them: the nth keyed request inside an operation begun with `keys` takes
// `<seed>.<n>`, and a nested operation with its own keys numbers under its
// own seed until it ends. `client.nextKey()` is the key a request takes now.
function withKeys(client) {
  withOps(client);
  const frames = [];
  let seeds = 0;
  client.keySeed = () => ({ seed: `seed${(seeds += 1)}`, stamps: new Map() });
  client.withOperation = async (_message, fn, { keys } = {}) => {
    const frame = keys ? { seed: keys.seed, n: 0 } : null;
    if (frame) frames.push(frame);
    try {
      return await fn(() => {});
    } finally {
      if (frame) frames.splice(frames.indexOf(frame), 1);
    }
  };
  client.nextKey = () => {
    const frame = frames.at(-1);
    return frame ? `${frame.seed}.${(frame.n += 1) - 1}` : null;
  };
  return client;
}

// A server holding one body. `edit` answers a key it has stored from what it
// stored (422 for another request under it), refuses a stale base with 409
// and `text-changed`, applies the ops otherwise and answers the text with a
// reshape. `onEdit(call, n)` may answer first: a string is a new stored body
// written by someone else just before the edit arrives, an error is thrown
// after the edit is applied (a lost answer). `afterEdit(n)` runs after an
// edit is applied, before its answer.
function setup({ input = INPUT, body = 'the big dog ran', stored, onEdit, afterEdit } = {}) {
  const raw = withBody(rawDocFromConllu(input, 'text-doc'), body);
  const base = textOf(raw).body;
  const server = { body: stored ?? base, digest: undefined, reads: 0, textReads: 0 };
  const sent = [];
  const keys = [];
  const replayed = [];
  const byKey = new Map();
  const client = withKeys({
    texts: {
      edit: async (id, ops, _message, { base: digest } = {}) => {
        const call = { id, ops, digest };
        const key = client.nextKey();
        sent.push(call);
        keys.push(key);
        const said = JSON.stringify(call);
        if (key && byKey.has(key)) {
          const kept = byKey.get(key);
          if (kept.said !== said) {
            throw Object.assign(new Error('HTTP 422 key reused'), {
              status: 422,
              method: 'PATCH',
              responseData: { error: 'idempotency-key-reused' },
            });
          }
          replayed.push(key);
          return kept.answer;
        }
        const answer = onEdit?.(call, sent.length);
        if (typeof answer === 'string') server.body = answer;
        if (digest !== digestOf(server.body)) {
          throw Object.assign(new Error('HTTP 409 The text was changed since it was read.'), {
            status: 409,
            method: 'PATCH',
            responseData: { 'text-changed': true, digest: digestOf(server.body) },
          });
        }
        server.body = applyTextOps(server.body, ops);
        const out = {
          id,
          body: server.body,
          digest: digestOf(server.body),
          reshape: { tokens: [], spans: [], vocabLinks: [], deleted: {} },
        };
        if (key) byKey.set(key, { said, answer: out });
        afterEdit?.(sent.length);
        if (answer instanceof Error) throw answer;
        return out;
      },
    },
    documents: {
      get: async () => {
        server.reads += 1;
        const digest = server.digest === undefined ? digestOf(server.body) : server.digest;
        return withBody(raw, server.body, digest);
      },
    },
  });
  // The text alone, as stored now.
  client.texts.get = async (id) => {
    server.textReads += 1;
    return { id, body: server.body, digest: digestOf(server.body) };
  };
  const doc = new ConlluDocument({ raw, client });
  // The queue sends a lost answer's edit again at once.
  doc._writes._retryDelay = () => 0;
  const text = textOf(raw);
  return { doc, base, server, sent, keys, replayed, text };
}

// The gaps that turn `base` into `mine`, as the Text Editor's log sends them.
const edited = (base, mine) =>
  recordEdit(startEditLog(base, digestOf(base)), base, null, mine, null);

// The seed part of an Idempotency-Key.
const seedOf = (key) => key.slice(0, key.lastIndexOf('.'));

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

test('a save whose answer was lost goes again as the same request under the same key, and is answered from what it stored', async () => {
  const { doc, base, sent, keys, replayed, server } = setup({
    onEdit: (_c, n) => (n === 1 ? lostAnswer() : null),
  });
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(keys[1], keys[0]);
  assert.deepEqual(replayed, [keys[0]]);
  assert.equal(server.body, `${base} home`);
  assert.equal(stored, `${base} home`);
  assert.equal(doc.body, `${base} home`);
  assert.ok(!doc.error);
  // The stored text is the one answered, so the document is not read.
  assert.equal(server.textReads, 1);
  assert.equal(server.reads, 0);
});

test('a resent save that landed is saved when the text cannot be read after it', async () => {
  const { doc, base, server } = setup({
    onEdit: (_c, n) => (n === 1 ? lostAnswer() : null),
  });
  doc._client.texts.get = async () => {
    throw Object.assign(new Error('HTTP 500'), { status: 500, method: 'GET' });
  };
  const logged = console.error;
  console.error = () => {};
  let stored = null;
  try {
    const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
    assert.equal(ok, true);
  } finally {
    console.error = logged;
  }
  assert.equal(server.body, `${base} home`);
  assert.equal(stored, `${base} home`);
  assert.ok(!doc.error);
});

test('a save whose answer was lost twice after it landed is stored once and answered from its key', async () => {
  const { doc, base, sent, keys, replayed, server } = setup();
  const edit = doc._client.texts.edit;
  let answers = 0;
  doc._client.texts.edit = async (...args) => {
    const out = await edit(...args);
    answers += 1;
    if (answers <= 2) throw lostAnswer();
    return out;
  };
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(sent.length, 3);
  assert.deepEqual(new Set(keys).size, 1);
  assert.deepEqual(replayed, [keys[0], keys[0]]);
  assert.equal(server.body, `${base} home`);
  assert.equal(stored, `${base} home`);
  assert.ok(!doc.error);
});

test('a save whose answer was lost and which did not land is sent again under the same key', async () => {
  const { doc, base, sent, keys, server } = setup();
  // The first send fails before the server applies it.
  const edit = doc._client.texts.edit;
  const lost = [];
  doc._client.texts.edit = async (...args) => {
    if (lost.length === 0) {
      lost.push(doc._client.nextKey());
      throw lostAnswer();
    }
    return edit(...args);
  };
  assert.equal(await doc.saveText(edited(base, `${base} home`)), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(keys, lost);
  assert.equal(server.body, `${base} home`);
});

// REV-edit-ops R11: the save landed and its answer was lost for good, and
// another user saved before the page heard anything. Reading the text and
// moving our edits onto it would move a delete that is already there (a
// second `the` deleted, or "changed elsewhere" for a save that landed).
test('a landed save whose answer was lost is not moved onto a text saved after it', async () => {
  const { doc, base, sent, keys, replayed, server } = setup({
    input: DOUBLED,
    body: 'I saw the the dog',
    onEdit: (_c, n) => (n === 1 ? lostAnswer() : null),
    afterEdit: (n) => {
      if (n === 1) server.body += ' ran';
    },
  });
  let stored = null;
  const ok = await doc.saveText(edited(base, 'I saw the dog'), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.ok(!doc.error);
  assert.equal(server.body, 'I saw the dog ran');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(keys[1], keys[0]);
  assert.deepEqual(replayed, [keys[0]]);
  // The replay answered with the body the first send stored. The text is read
  // again and shows what is stored now (REV2-edit-ops U1).
  assert.equal(stored, 'I saw the dog ran');
  assert.equal(doc.body, 'I saw the dog ran');
});

// REV-edit-ops R10: a 409 moves the edits onto the new text as a new request
// under a new key. That request's answer is lost, and the run goes again: it
// sends that same request under that same key, not the first one's.
test('after a 409 and then a lost answer, the moved request goes again under its own key', async () => {
  const { doc, base, sent, keys, replayed, server } = setup({
    input: DOUBLED,
    body: 'I saw the the dog',
    onEdit: (_c, n) => (n === 1 ? 'I saw the the dog.' : n === 2 ? lostAnswer() : null),
    afterEdit: (n) => {
      if (n === 2) server.body += ' It ran.';
    },
  });
  let stored = null;
  const ok = await doc.saveText(edited(base, 'I saw the dog'), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.ok(!doc.error);
  assert.equal(server.body, 'I saw the dog. It ran.');
  assert.equal(sent.length, 3);
  assert.equal(sent[1].digest, digestOf('I saw the the dog.'));
  assert.deepEqual(sent[2], sent[1]);
  assert.equal(keys[2], keys[1]);
  assert.notEqual(seedOf(keys[1]), seedOf(keys[0]));
  assert.deepEqual(replayed, [keys[1]]);
  assert.equal(stored, 'I saw the dog. It ran.');
  assert.equal(doc.body, 'I saw the dog. It ran.');
});

test('a key refused as used for another request reads the text back and keeps what is stored', async () => {
  const { doc, base, sent, server } = setup();
  server.body = `${base} home`;
  doc._client.texts.edit = async (id, ops, _m, { base: digest } = {}) => {
    sent.push({ id, ops, digest });
    throw Object.assign(new Error('HTTP 422 key reused'), {
      status: 422,
      method: 'PATCH',
      responseData: { error: 'idempotency-key-reused', 'idempotency-key-reused': true },
    });
  };
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(server.reads, 1);
  assert.equal(stored, `${base} home`);
  assert.equal(doc.body, `${base} home`);
  assert.ok(!doc.error);
});

// REV2-edit-ops K1: what the reused key stored is some other request's, and
// the stored text does not hold this save's change.
test('a key refused as used for another request, over a text without the change, is refused', async () => {
  const { doc, base, sent, server } = setup();
  doc._client.texts.edit = async (id, ops, _m, { base: digest } = {}) => {
    sent.push({ id, ops, digest });
    throw Object.assign(new Error('HTTP 422 key reused'), {
      status: 422,
      method: 'PATCH',
      responseData: { error: 'idempotency-key-reused' },
    });
  };
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), {
    onStored: (b) => (stored = b),
  });
  assert.equal(ok, false);
  assert.equal(stored, null);
  assert.equal(server.body, base);
  assert.match(doc.error, /same passage was changed elsewhere/);
});

// REV2-edit-ops G1, after REV4 J1: a lost answer is sent again for as long
// as the page is open, the screen gone or not, and the save lands once.
test('a save whose answer is lost after the screen has gone is sent again until it lands, once', async () => {
  const { doc, base, sent, keys, replayed, server } = setup();
  const edit = doc._client.texts.edit;
  let answers = 0;
  doc._client.texts.edit = async (...args) => {
    const out = await edit(...args);
    answers += 1;
    if (answers <= 2) throw lostAnswer();
    return out;
  };
  doc._writes.letGo();
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(sent.length, 3);
  assert.equal(new Set(keys).size, 1);
  assert.deepEqual(replayed, [keys[0], keys[0]]);
  assert.equal(server.body, `${base} home`);
  assert.equal(stored, `${base} home`);
  assert.ok(!doc.error);
});

// REV-edit-ops R15: a body holding `\r` keeps it, and the log's stored form
// is what was stored.
test('a save over a body holding \\r keeps every \\r', async () => {
  const body = 'the big\r\ndog ran';
  const { doc, server } = setup({ body });
  let log = startEditLog(body, digestOf(body));
  log = recordEdit(log, log.body, { start: 7, end: 7 }, 'the bigs\ndog ran', 8);
  assert.equal(log.raw, 'the bigs\r\ndog ran');
  let stored = null;
  assert.equal(await doc.saveText(log, { onStored: (b) => (stored = b) }), true);
  assert.equal(server.body, 'the bigs\r\ndog ran');
  assert.equal(stored, log.raw);
});

// REV-edit-ops R4, the ud side: an edit without `base` has no precondition,
// and would land at the wrong places on a text saved meanwhile.
test('a save over a text whose digest is not known reads it first, and never goes without one', async () => {
  const { doc, sent, server } = setup();
  doc._raw = withBody(doc._raw, 'the big dog ran', null);
  doc._dataVersion += 1;
  const log = { ...edited('the big dog ran', 'the big dog ran home'), digest: null };
  assert.equal(await doc.saveText(log), true);
  assert.equal(server.reads, 1);
  assert.deepEqual(
    sent.map((c) => c.digest),
    [digestOf('the big dog ran')],
  );
  assert.equal(server.body, 'the big dog ran home');
});

test('a save over a text whose digest cannot be learned is refused and nothing is sent', async () => {
  const { doc, sent, server } = setup();
  server.digest = null;
  doc._raw = withBody(doc._raw, 'the big dog ran', null);
  doc._dataVersion += 1;
  const log = { ...edited('the big dog ran', 'the big dog ran home'), digest: null };
  assert.equal(await doc.saveText(log), false);
  assert.equal(sent.length, 0);
  assert.equal(server.body, 'the big dog ran');
  assert.ok(doc.error);
});

// REV-edit-ops R1: both users deleted one of a doubled word. Put onto the
// stored text, our delete would take the other `the` as well.
test('a draft deleting one of a doubled word that the stored text already lost is refused', async () => {
  const { doc, base, sent, server } = setup({
    input: DOUBLED,
    body: 'I saw the the dog',
    onEdit: (_c, n) => (n === 1 ? 'I saw the dog!' : null),
  });
  const ok = await doc.saveText(edited(base, 'I saw the dog'));
  assert.equal(ok, false);
  assert.equal(sent.length, 1);
  assert.equal(server.body, 'I saw the dog!');
  assert.match(doc.error, /same passage was changed elsewhere/);
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

// REV3-edit-ops G1-gap: the save landed with its answer lost, and its resend
// is refused without reaching the server (a 403 or a 500), or refused as a
// key used for another request after someone else saved. The stored text
// holds the save's change, so the save has landed.
for (const status of [403, 500]) {
  test(`a landed save whose resend is refused ${status} is saved when the stored text holds it`, async () => {
    const { doc, base, server } = setup({
      onEdit: (_c, n) => (n === 1 ? lostAnswer() : null),
    });
    const edit = doc._client.texts.edit;
    let calls = 0;
    doc._client.texts.edit = async (...args) => {
      calls += 1;
      if (calls === 2)
        throw Object.assign(new Error(`HTTP ${status}`), { status, method: 'PATCH' });
      return edit(...args);
    };
    let stored = null;
    const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
    assert.equal(ok, true);
    assert.equal(server.body, `${base} home`);
    assert.equal(stored, `${base} home`);
    assert.equal(doc.body, `${base} home`);
    assert.ok(!doc.error);
  });
}

test('a save whose resend is refused 500 and which did not land is refused', async () => {
  const { doc, base, server } = setup();
  let calls = 0;
  doc._client.texts.edit = async () => {
    calls += 1;
    if (calls === 1) throw lostAnswer();
    throw Object.assign(new Error('HTTP 500'), { status: 500, method: 'PATCH' });
  };
  const ok = await doc.saveText(edited(base, `${base} home`));
  assert.equal(ok, false);
  assert.equal(server.body, base);
});

test('a key refused as used for another request after someone else saved: stored holds the change, so saved', async () => {
  const { doc, base, sent, server } = setup();
  // Ours landed, then someone else's save at the start.
  server.body = `a big dog ran home`;
  doc._client.texts.edit = async (id, ops, _m, { base: digest } = {}) => {
    sent.push({ id, ops, digest });
    throw Object.assign(new Error('HTTP 422 key reused'), {
      status: 422,
      method: 'PATCH',
      responseData: { error: 'idempotency-key-reused' },
    });
  };
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(stored, 'a big dog ran home');
  assert.equal(doc.body, 'a big dog ran home');
  assert.ok(!doc.error);
});

// REV3-edit-ops U1-client: a replay inside the client's own resend carries
// the body its first send stored, and someone else saved since.
test('an answer the client replayed is followed by a read of the text stored', async () => {
  const { doc, base, server } = setup();
  const edit = doc._client.texts.edit;
  doc._client.texts.edit = async (...args) => {
    const out = await edit(...args);
    server.body = `a big dog ran home`;
    return Object.defineProperty({ ...out }, 'replayed', { value: true, enumerable: false });
  };
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(server.textReads, 1);
  assert.equal(doc.body, 'a big dog ran home');
  assert.equal(stored, 'a big dog ran home');
});

// REV4-edit-ops G1-gap on the client's own resend: plaid-client stores the
// first send, loses its answer and sends it again under the same key, and
// that is answered 500. The app sees one plain refusal, and the stored text
// decides.
test('a save stored by a send the client resent itself, the resend refused 500, is saved', async () => {
  const { doc, base, server } = setup();
  const edit = doc._client.texts.edit;
  doc._client.texts.edit = async (...args) => {
    doc._client.texts.edit = edit;
    await edit(...args);
    throw Object.assign(new Error('HTTP 500'), { status: 500, method: 'PATCH' });
  };
  let stored = null;
  const ok = await doc.saveText(edited(base, `${base} home`), { onStored: (b) => (stored = b) });
  assert.equal(ok, true);
  assert.equal(server.body, `${base} home`);
  assert.equal(stored, `${base} home`);
  assert.equal(doc.body, `${base} home`);
  assert.ok(!doc.error);
});

test('a first send refused 500 that stored nothing is refused', async () => {
  const { doc, base, server } = setup();
  doc._client.texts.edit = async () => {
    throw Object.assign(new Error('HTTP 500'), { status: 500, method: 'PATCH' });
  };
  const ok = await doc.saveText(edited(base, `${base} home`));
  assert.equal(ok, false);
  assert.equal(server.body, base);
});

test('a save takes the edits typed, never a whole new body, which would delete the words between two changes', async () => {
  // REV2 L5: a string went as one replace of the whole body, and the core
  // deleted every word between the two changes.
  const { doc, base, sent } = setup({ body: 'dog cat eel fox.' });
  await assert.rejects(() => doc.saveText('dot cat eel fix.'), /edits/);
  assert.deepEqual(sent, []);
  const log = recordEdit(
    edited(base, 'dot cat eel fox.'),
    'dot cat eel fox.',
    null,
    'dot cat eel fix.',
    null,
  );
  assert.equal(await doc.saveText(log), true);
  assert.deepEqual(sent[0].ops, [
    { type: 'replace', index: 2, length: 1, value: 't' },
    { type: 'replace', index: 13, length: 1, value: 'i' },
  ]);
});
