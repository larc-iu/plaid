// A server for the Media tab's segment writes, in memory: it keeps a stored
// document, answers every read with it, and applies the text and token writes
// a segment edit sends, refusing a text write whose `base` is not the digest
// of the body stored (409, `text-changed`) as the core does. A batch is
// atomic: when one of its writes is refused, nothing of it is stored.
// `other` writes as another user, with an entry in the audit log naming the
// rows it wrote, so a toast can say who changed a segment. Not imported by
// app code.

import { createHash } from 'node:crypto';
import { applyTextEditsLocally } from '@/domain/textEdits.js';
import { makeFakeClient } from '@/domain/test-helpers.js';

export const digestOf = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

const textOf = (raw) => raw.textLayers[0].text;
const layerOf = (raw, id) => raw.textLayers[0].tokenLayers.find((l) => l.id === id);
const refused = (status, data) =>
  Object.assign(new Error(`HTTP ${status} ${data.error}`), { status, responseData: data });

// The writes a segment edit sends, applied to `raw` in place. Each answers
// what the server answers.
const writesOn = (raw, mint) => ({
  'texts.update': (textId, ops, auditMessage, { base } = {}) => {
    const text = textOf(raw);
    const digest = digestOf(text.body);
    if (base != null && base !== digest) {
      throw refused(409, {
        error: 'The text was changed since it was read.',
        'text-changed': true,
        digest,
      });
    }
    applyTextEditsLocally(raw, textId, ops, null);
    text.digest = digestOf(text.body);
    return { id: textId, body: text.body, digest: text.digest };
  },
  'tokens.create': (layerId, textId, begin, end, precedence, metadata) => {
    const id = mint();
    const layer = layerOf(raw, layerId);
    layer.tokens.push({ id, text: textId, begin, end, metadata: metadata ?? {} });
    layer.tokens.sort((a, b) => a.begin - b.begin);
    return { id };
  },
  'tokens.bulkCreate': (list) => {
    const ids = list.map((t) => {
      const id = mint();
      layerOf(raw, t.tokenLayerId).tokens.push({ id, text: t.text, begin: t.begin, end: t.end });
      return id;
    });
    return { ids };
  },
  'tokens.delete': (id) => {
    const layer = raw.textLayers[0].tokenLayers.find((l) => l.tokens.some((t) => t.id === id));
    // What strict mode answers for a row that is gone.
    if (!layer) {
      throw refused(409, {
        error: 'Document version mismatch. What this request names is no longer in the document.',
      });
    }
    layer.tokens = layer.tokens.filter((t) => t.id !== id);
    return {};
  },
});

export function segmentServer(raw) {
  let stored = structuredClone(raw);
  textOf(stored).digest = digestOf(textOf(stored).body);
  let n = 0;
  const mint = () => `seg-${++n}`;
  const audit = [];
  // Every request this page sent that writes: `{ kind, args }`, a batch as
  // one entry of kind 'batch' whose `ops` are its writes.
  const sent = [];
  // Refusals to answer the next writes with, before any is applied.
  const refusals = [];

  const client = makeFakeClient();
  client.documents.get = async () => structuredClone(stored);
  client.documents.auditPage = async () => ({ entries: [...audit].reverse() });

  // Apply `ops` ([kind, args] pairs) as one transaction, or none of them.
  const apply = (ops) => {
    if (refusals.length) throw refusals.shift();
    const draft = structuredClone(stored);
    const on = writesOn(draft, mint);
    const results = ops.map(([kind, args]) => ({ status: 200, body: on[kind](...args) }));
    stored = draft;
    return results;
  };

  client.batched = async (fn) => {
    const ops = [];
    const queue =
      (kind) =>
      (...args) => {
        ops.push([kind, args]);
      };
    await fn({
      texts: { update: queue('texts.update') },
      tokens: {
        create: queue('tokens.create'),
        delete: queue('tokens.delete'),
        bulkCreate: queue('tokens.bulkCreate'),
      },
    });
    sent.push({ kind: 'batch', ops: ops.map(([kind, args]) => ({ kind, args })) });
    return apply(ops);
  };
  for (const [group, method] of [
    ['texts', 'update'],
    ['tokens', 'create'],
    ['tokens', 'delete'],
    ['tokens', 'bulkCreate'],
  ]) {
    const kind = `${group}.${method}`;
    client[group][method] = async (...args) => {
      sent.push({ kind, args });
      return apply([[kind, args]])[0].body;
    };
  }
  client.tokens.patchMetadata = async (...args) => {
    sent.push({ kind: 'tokens.patchMetadata', args });
    return {};
  };

  return {
    client,
    sent,
    get stored() {
      return stored;
    },
    get body() {
      return textOf(stored).body;
    },
    get digest() {
      return textOf(stored).digest;
    },
    segments: () => layerOf(stored, 'alignL').tokens,
    // Refuse the next write with `status` (a document version that moved,
    // with the body unchanged).
    refuseNext: (status = 409, error = 'Document version mismatch.') =>
      refusals.push(refused(status, { error })),
    // Another user's edit of the segment `id`'s text, as the Media tab makes
    // it: the text replaced and the segment made again over the same time.
    otherEdits(id, value, user = 'b') {
      const segment = layerOf(stored, 'alignL').tokens.find((t) => t.id === id);
      const on = writesOn(stored, mint);
      on['texts.update'](textOf(stored).id, [
        { type: 'delete', index: segment.begin, value: segment.end - segment.begin },
        { type: 'insert', index: segment.begin, value },
      ]);
      const { id: made } = on['tokens.create'](
        'alignL',
        textOf(stored).id,
        segment.begin,
        segment.begin + [...value].length,
        undefined,
        segment.metadata,
      );
      audit.push({
        user: { id: user, displayName: user },
        ops: [{ description: `Delete token ${id}` }, { description: `Create token ${made}` }],
      });
      return made;
    },
  };
}
