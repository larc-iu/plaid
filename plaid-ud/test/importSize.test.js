// A CoNLL-U import goes as consecutive requests (the text and its tokens, then
// the spans, then the relations), so a document has to fit the server's cap on
// a request's body one part at a time, not as a whole (REV-DEBT-R2 F1: a
// 12,224-word GUM file was refused 413 once the import was one request).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

// `count` sentences of ten words, each with a lemma, a UPOS, features and a
// head, which is what makes a treebank heavy.
const treebank = (count) => {
  const out = [];
  for (let s = 0; s < count; s += 1) {
    const words = Array.from({ length: 10 }, (_, i) => `w${s}x${i}`);
    out.push(`# text = ${words.join(' ')}`);
    words.forEach((w, i) => {
      const head = i === 0 ? 0 : 1;
      const rel = i === 0 ? 'root' : 'dep';
      out.push(`${i + 1}\t${w}\tl${w}\tNOUN\tNN\tCase=Nom|Number=Sing\t${head}\t${rel}\t_\t_`);
    });
    out.push('');
  }
  return out.join('\n');
};

// A client whose requests are refused 413 over `cap` bytes of JSON, as the
// core refuses a body over its cap. Records each request's size.
const cappedClient = (cap) => {
  const sizes = [];
  const sent = (body) => {
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bytes > cap) {
      throw Object.assign(new Error(`HTTP 413 Request body exceeds JSON cap of ${cap} bytes`), {
        status: 413,
        method: 'POST',
      });
    }
    sizes.push(bytes);
  };
  let deleted = false;
  const client = {
    sizes,
    deleted: () => deleted,
    documents: {
      create: async () => ({ id: 'doc-1' }),
      get: async () => {
        throw new Error('the layer info is precomputed');
      },
      delete: async () => {
        deleted = true;
      },
    },
    batched: async (fn) => {
      const ops = [];
      const op =
        (name) =>
        (...args) =>
          ops.push([name, args]);
      await fn({
        texts: { create: op('texts.create') },
        tokens: { bulkCreate: op('tokens.bulkCreate') },
        spans: { bulkCreate: op('spans.bulkCreate') },
        relations: { bulkCreate: op('relations.bulkCreate') },
      });
      if (ops.length) sent(ops);
      return ops.map(() => ({ body: {} }));
    },
  };
  return client;
};

test('an import too large for one request goes in parts that each fit', async () => {
  const input = treebank(300);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm', { enhanced: true }));
  // Measure the parts with no cap, then cap below the whole.
  const free = cappedClient(Infinity);
  await ConlluDocument.importFromConllu(free, 'p1', 'm', input, info);
  const whole = free.sizes.reduce((a, b) => a + b, 0);
  const largest = Math.max(...free.sizes);
  assert.ok(free.sizes.length >= 3, `sent as ${free.sizes.length} requests`);
  assert.ok(largest < whole * 0.6, 'no part carries most of the document');

  const capped = cappedClient(largest);
  const out = await ConlluDocument.importFromConllu(capped, 'p1', 'm', input, info);
  assert.equal(out.documentId, 'doc-1');
  assert.equal(capped.deleted(), false);
});

test('a part over the cap is refused 413 and the document is taken back', async () => {
  const input = treebank(50);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm', { enhanced: true }));
  const client = cappedClient(1000);
  await assert.rejects(
    ConlluDocument.importFromConllu(client, 'p1', 'm', input, info),
    (err) => err.status === 413,
  );
  assert.equal(client.deleted(), true);
});
