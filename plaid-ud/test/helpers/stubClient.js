// Add the client surface a ConlluDocument mutation reaches (withOperation & co.,
// plus the batch methods) to a bare
// per-test stub client. Every ConlluDocument mutation runs inside
// `client.withOperation(label, fn)`, so a stub that only implements the
// resource calls a test cares about still needs this to be invocable. Nesting
// flattens exactly like the real client; nothing is sent.
export function withOps(client) {
  const c = client;
  if (typeof c.withOperation === 'function') return c;
  // Batch surface the domain reaches on the failure/reload path and in the
  // batched mutations: built on the stub's own beginBatch/submitBatch when it
  // has them (call recording), otherwise inert.
  if (typeof c.isBatchMode !== 'function') c.isBatchMode = () => !!c._batching;
  if (typeof c.abortBatch !== 'function') {
    c.abortBatch = () => {
      c._batching = false;
    };
  }
  if (typeof c.batched !== 'function') {
    c.batched = async (fn) => {
      c._batching = true;
      c.beginBatch?.();
      try {
        await fn();
      } catch (e) {
        c.abortBatch();
        throw e;
      }
      c._batching = false;
      return c.submitBatch ? c.submitBatch() : [];
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
