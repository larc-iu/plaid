// A client that answers every write with fresh ids and remembers the calls,
// so a test can read exactly what a document mutation sent: plaid-client's own
// test client (`fakeClient`, plaid-client-js testing.js), whose batches and
// operations are the real client's. `batched` sends the queued ops as one
// request, answered in order like the server: one `{ status, headers, body }`
// per op. Not a test file itself, so the runner does not pick it up.
//
// `calls` is every write, batched or not, as `{ name, args }` when it reaches
// the server (a batched one when its batch is sent), and each logical
// operation begun as `{ name: 'operation', args: [label], kind? }`.
// `requests` is the ROUND TRIPS: one entry per direct write and one per batch
// request, `{ name: 'batch', args: [ops] }`, whatever the batch holds, which
// is what a test about how much a mutation costs has to count.
//
// A metadata patch must be a list of ops, as the server takes it, and is
// refused here as there when it is not.
//
// `answer`, when given, is asked first about each write as it reaches the
// server, `{ kind, args, batched }`: what it returns (or resolves to) is the
// answer, undefined leaves the usual one, and what it throws refuses the
// write, which is then not recorded. A test holds or refuses a write here,
// batched or not, since a batched write never runs through the client's own
// methods.
// By its path: the apps' vite alias maps the package to its index.js alone.
import { fakeClient } from '../../plaid-client-js/src/testing.js';

// The reads reconcile makes first: nobody holds the lock, and the audit log
// records nothing in the window it asks about.
const READS = {
  'documents.get': () => null,
  'documents.checkLock': () => null,
  'documents.auditPage': () => ({ entries: [], nextCursor: null }),
};

export function recordingClient({ answer } = {}) {
  let n = 0;
  const id = () => `new${++n}`;
  const calls = [];
  const requests = [];
  const client = fakeClient({
    onRequest: (r) => {
      if (r.operations) requests.push({ name: 'batch', args: [r.operations.length] });
      else if (r.method !== 'GET') requests.push({ name: r.kind, args: r.args });
    },
    answer: async (request) => {
      const { kind, args, method } = request;
      if (method === 'GET') return READS[kind]?.(...args);
      const given = await answer?.(request);
      calls.push({ name: kind, args });
      if (given !== undefined) return given;
      if (kind?.endsWith('.bulkCreate')) return { ids: args[0].map(() => id()) };
      // The server answers a create, a copy included, with the new id alone.
      if (/\.(create|copy)$/.test(kind ?? '')) return { id: id() };
      return {};
    },
  });
  // Not a round trip of its own: it only labels the ones inside it. Its kind,
  // when it has one, rides beside the label.
  const withOperation = client.withOperation.bind(client);
  client.withOperation = (label, fn, options = {}) => {
    calls.push({
      name: 'operation',
      args: [label],
      ...(options.kind ? { kind: options.kind } : {}),
    });
    return withOperation(label, fn, options);
  };
  return { client, calls, requests };
}
