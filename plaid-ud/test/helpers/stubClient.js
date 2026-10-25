// A per-test stub client made able to run a ConlluDocument mutation, on
// plaid-client's own test client (`fakeClient`, plaid-client-js testing.js):
// its batches and logical operations are the real client's, and each request
// they make is answered by the stub's method of the same name, so a test still
// reads what its stub was asked. A call made on the stub itself runs at once,
// as it does on the real client.
import { PlaidClient } from '@larc-iu/plaid-client';
// By its path, as igt's and umr's helpers import it.
import { fakeClient } from '../../../plaid-client-js/src/testing.js';

// The stub's own method answers each request the real client makes. A relabel
// of an operation is the operation's own, and answered here when the stub
// has none. A method the stub lacks is refused, as calling it would throw.
const stubAnswer =
  (stub) =>
  ({ kind, args }) => {
    if (!kind) return undefined;
    const [name, method] = kind.split('.');
    const bundle = method ? stub[name] : stub;
    const fn = bundle?.[method ?? name];
    if (typeof fn === 'function') return fn.apply(bundle, args);
    if (kind === 'operationGroups.update') return {};
    throw new TypeError(`The stub client has no ${kind}`);
  };

// A batch of the real client over `client`: its writes QUEUE, `submit()` has
// the stub's methods answer them in order, one `{ status, headers, body }`
// each, and `abort()` drops them. A read made on it is answered at once. What
// it queued is `queued`, `{ kind, args }` per write.
export function batchOf(client) {
  return fakeClient({ answer: stubAnswer(client) }).batch();
}

// Add the client surface a ConlluDocument mutation reaches (withOperation & co.,
// plus `batch`/`batched`) to a bare per-test stub client, in place. Every
// ConlluDocument mutation runs inside `client.withOperation(label, fn)`, so a
// stub that only implements the resource calls a test cares about still needs
// this to be invocable. Nesting flattens as the real client's does, and
// `operations` is every operation begun, outermost only, with its kind and
// ref. A stub that needs its submit to answer particular ids brings its own
// `batched` and builds it on `batchOf`.
export function withOps(client) {
  const c = client;
  if (typeof c.withOperation === 'function') return c;
  const real = fakeClient({ answer: stubAnswer(c) });
  if (typeof c.batch !== 'function') c.batch = (options) => real.batch(options);
  if (typeof c.batched !== 'function') {
    c.batched = (fn, options) => PlaidClient.prototype.batched.call(c, fn, options);
  }
  Object.defineProperty(c, 'operationGroup', {
    configurable: true,
    get: () => real.operationGroup,
  });
  c.operations = real.operations;
  c.beginOperation = (message, options) => real.beginOperation(message, options);
  c.endOperation = (message) => real.endOperation(message);
  c.withOperation = (message, fn, options) => real.withOperation(message, fn, options);
  return c;
}
