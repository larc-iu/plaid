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

class BatchRef {
  constructor(op, index) {
    this.op = op;
    this.$ref = op;
    if (index !== undefined) this.index = index;
  }
}

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
    tokenLayers: {
      setConfig: async (layerId, namespace, key, value, message, options) =>
        record('tokenLayers.setConfig', layerId, namespace, key, value, message, options),
    },
    documents: {
      get: async () => null,
      // Reads reconcile makes first: nobody holds the lock, and the audit log
      // records nothing in the window it asks about.
      checkLock: async () => null,
      auditPage: async () => ({ entries: [], nextCursor: null }),
      update: async (documentId, name) => record('documents.update', documentId, name),
      // The server answers a copy with the new document's id alone.
      copy: async (documentId, name) => {
        record('documents.copy', documentId, name);
        return { id: id() };
      },
    },
    // The server's clock, which reconcile judges an audit entry's age by.
    serverNow: () => new Date(),
    // Not a round trip of its own: it only labels the ones inside it. Its
    // kind, when it has one, rides beside the label.
    withOperation: async (label, fn, { kind } = {}) => {
      calls.push({ name: 'operation', args: [label], ...(kind ? { kind } : {}) });
      return fn(() => {});
    },
    // `b.ref(n, index)` stands for the id op n of the batch makes (the ids[index]
    // of a bulk create), as the real batch's does, and is filled in, at any
    // depth of the op's arguments, when the op that names it runs.
    batched: async (fn) => {
      const queue = [];
      const out = [];
      const fill = (v) => {
        if (v instanceof BatchRef) {
          const body = out[v.op]?.body;
          return v.index === undefined ? body?.id : body?.ids?.[v.index];
        }
        if (Array.isArray(v)) return v.map(fill);
        if (v && Object.getPrototypeOf(v) === Object.prototype) {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
        }
        return v;
      };
      const proxy = (group) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                queue.push(() => api[group][method](...args.map(fill))),
          },
        );
      const ref = (n = -1, index) => new BatchRef(n < 0 ? queue.length + n : n, index);
      await fn({
        tokens: proxy('tokens'),
        spans: proxy('spans'),
        relations: proxy('relations'),
        tokenLayers: proxy('tokenLayers'),
        ref,
      });
      requests.push({ name: 'batch', args: [queue.length] });
      inBatch = true;
      try {
        for (const op of queue) out.push({ body: await op() });
        return out;
      } finally {
        inBatch = false;
      }
    },
  };
  return { client: api, calls, requests };
}
