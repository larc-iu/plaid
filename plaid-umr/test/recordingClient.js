// A client that answers every write with fresh ids and remembers the calls,
// so a test can read exactly what a document mutation sent. `batched` runs
// the queued ops in order and answers like the server: one `{ body }` per
// op. Not a test file itself, so the runner does not pick it up.
//
// `calls` is every operation, batched or not. `requests` is the ROUND TRIPS:
// one entry per direct call and one per batch, whatever the batch holds,
// which is what a test about how much a mutation costs has to count.
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
      patchMetadata: async (spanId, patch) => record('spans.patchMetadata', spanId, patch),
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
      patchMetadata: async (relId, patch) => record('relations.patchMetadata', relId, patch),
      delete: async (relId) => record('relations.delete', relId),
    },
    documents: { get: async () => null },
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
