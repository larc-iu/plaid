// A client that answers every write with fresh ids and remembers the calls,
// so a test can read exactly what a document mutation sent. `batched` runs
// the queued ops in order and answers like the server: one `{ body }` per
// op. Not a test file itself, so the runner does not pick it up.
//
// `calls` is every operation, batched or not. `requests` is the ROUND TRIPS:
// one entry per direct call and one per batch, whatever the batch holds,
// which is what a test about how much a mutation costs has to count.
//
// A metadata patch must be a list of ops, as the server takes it, and is
// refused here as there when it is not.
import { applyMetadataOps } from '@larc-iu/plaid-client';

const checkOps = (ops) => {
  if (!Array.isArray(ops)) throw new Error('A metadata patch is a list of ops');
  applyMetadataOps({}, ops);
};

export function recordingClient() {
  let n = 0;
  const id = () => `new${++n}`;
  const calls = [];
  const requests = [];
  let inBatch = false;
  const record = (name, ...args) => {
    calls.push({ name, args });
    if (!inBatch) requests.push({ name, args });
  };
  const api = {
    tokens: {
      bulkCreate: async (ops) => {
        record('tokens.bulkCreate', ops);
        return { ids: ops.map(() => id()) };
      },
      bulkDelete: async (ids) => record('tokens.bulkDelete', ids),
      patchMetadata: async (tokenId, ops) => {
        checkOps(ops);
        record('tokens.patchMetadata', tokenId, ops);
      },
    },
    spans: {
      create: async (layer, tokens, value, metadata) => {
        record('spans.create', layer, tokens, value, metadata);
        return { id: id() };
      },
      bulkCreate: async (ops) => {
        record('spans.bulkCreate', ops);
        return { ids: ops.map(() => id()) };
      },
      update: async (spanId, value) => record('spans.update', spanId, value),
      patchMetadata: async (spanId, ops) => {
        checkOps(ops);
        record('spans.patchMetadata', spanId, ops);
      },
      setTokens: async (spanId, tokens) => record('spans.setTokens', spanId, tokens),
    },
    relations: {
      create: async (layer, source, target, value, metadata) => {
        record('relations.create', layer, source, target, value, metadata);
        return { id: id() };
      },
      bulkCreate: async (ops) => {
        record('relations.bulkCreate', ops);
        return { ids: ops.map(() => id()) };
      },
      update: async (relId, value) => record('relations.update', relId, value),
      patchMetadata: async (relId, ops) => {
        checkOps(ops);
        record('relations.patchMetadata', relId, ops);
      },
      delete: async (relId) => record('relations.delete', relId),
    },
    documents: {
      get: async () => null,
      update: async (documentId, name) => record('documents.update', documentId, name),
      // The server answers a copy with the new document's id alone.
      copy: async (documentId, name) => {
        record('documents.copy', documentId, name);
        return { id: id() };
      },
    },
    // Not a round trip of its own: it only labels the ones inside it.
    withOperation: async (label, fn) => {
      calls.push({ name: 'operation', args: [label] });
      return fn(() => {});
    },
    batched: async (fn) => {
      const queue = [];
      const proxy = (group) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                queue.push(() => api[group][method](...args)),
          },
        );
      await fn({ tokens: proxy('tokens'), spans: proxy('spans'), relations: proxy('relations') });
      requests.push({ name: 'batch', args: [queue.length] });
      inBatch = true;
      try {
        const out = [];
        for (const op of queue) out.push({ body: await op() });
        return out;
      } finally {
        inBatch = false;
      }
    },
  };
  return { client: api, calls, requests };
}
