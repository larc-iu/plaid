// A batch: a view of the stub carrying the same resource bundles, whose calls
// QUEUE rather than run. `submit()` runs them in order and answers one result
// per op, `abort()` drops them. A call made on the stub itself runs at once,
// as it does on the real client. Every bundle method on the view queues, reads
// included: nothing in these tests reads through a batch.
export function batchOf(client) {
  const operations = [];
  const batch = Object.create(client);
  for (const [name, bundle] of Object.entries(client)) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) continue;
    const methods = Object.entries(bundle).filter(([, fn]) => typeof fn === 'function');
    if (methods.length === 0) continue;
    const queued = {};
    for (const [method, fn] of methods) {
      queued[method] = (...args) => {
        operations.push({ op: `${name}.${method}`, run: () => fn(...args) });
        return { batched: true };
      };
    }
    batch[name] = queued;
  }
  batch.client = client;
  batch.operations = operations;
  batch.open = true;
  batch.submit = async () => {
    batch.open = false;
    const results = [];
    for (const op of operations) results.push({ status: 200, body: await op.run() });
    operations.length = 0;
    return results;
  };
  batch.abort = () => {
    operations.length = 0;
    batch.open = false;
  };
  return batch;
}

// Add the client surface a ConlluDocument mutation reaches (withOperation & co.,
// plus `batch`/`batched`) to a bare per-test stub client. Every ConlluDocument
// mutation runs inside `client.withOperation(label, fn)`, so a stub that only
// implements the resource calls a test cares about still needs this to be
// invocable. Nesting flattens exactly like the real client; nothing is sent.
// A stub that needs its submit to answer particular ids brings its own
// `batched` and builds it on `batchOf`.
export function withOps(client) {
  const c = client;
  if (typeof c.withOperation === 'function') return c;
  if (typeof c.batch !== 'function') c.batch = () => batchOf(c);
  if (typeof c.batched !== 'function') {
    c.batched = async (fn) => {
      const b = c.batch();
      try {
        await fn(b);
      } catch (e) {
        b.abort();
        throw e;
      }
      return b.submit();
    };
  }
  c.operationGroup = null;
  c.beginOperation = (message) => {
    if (c.operationGroup) {
      c.operationGroup.depth += 1;
      return c.operationGroup.id;
    }
    c.operationGroup = { id: `op-${message}`, message, depth: 1 };
    return c.operationGroup.id;
  };
  c.endOperation = async () => {
    if (!c.operationGroup) return;
    if (c.operationGroup.depth > 1) {
      c.operationGroup.depth -= 1;
      return;
    }
    c.operationGroup = null;
  };
  c.withOperation = async (message, fn) => {
    c.beginOperation(message);
    try {
      return await fn(() => {});
    } finally {
      await c.endOperation();
    }
  };
  return c;
}
