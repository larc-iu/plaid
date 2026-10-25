/**
 * A PlaidClient for tests, with no server. The twin of plaid-client-py's
 * `plaid_client.testing`, shipped as `@larc-iu/plaid-client/testing`.
 *
 *   import { fakeClient } from "@larc-iu/plaid-client/testing";
 *
 *   const client = fakeClient({
 *     answer: ({ kind, args }) =>
 *       kind === "documents.get" ? aDocument : undefined,
 *   });
 *   await editor.run(client);
 *   assert.deepEqual(client.calls.map((c) => c.kind), ["beginOperation", "tokens.create", "batch.submit"]);
 *
 * It is the real client: its bundles, its batch (the queue, the refs, the
 * split past MAX_BATCH_OPS, the refusal of a write on a batch already sent and
 * of a nested batch) and its logical operations (the closed list of kinds,
 * nesting, the relabel sent only when a write joined) are the ones an app
 * runs. Only the transport is replaced: each request is recorded and
 * answered by `answer` instead of going out, so a test passes only on calls
 * the real client makes.
 *
 * What it records, in order, under `client.calls` as `{kind, args}`:
 * - each call of a bundle method (`"tokens.create"`, `"query"`) whose request
 *   is not a read, with the arguments it was given, when it is made (on the
 *   client or queued on a batch);
 * - `"beginOperation"`, when an outermost logical operation begins, its args
 *   `[message]`, or `[message, {kind, ref}]` when either was given;
 * - `"batch.submit"`, args `[]`, each time a batch is submitted.
 *
 * `client.requests` is each round trip as it would have gone out:
 * `{method, path, query, body, kind, args}`, the body as the server reads it
 * (kebab keys) and the call that made it, and one `{method: "POST", path:
 * "/api/v1/batch", operations}` per batch request. `onRequest`, when given,
 * hears each as it goes. `client.operations` is each outermost operation
 * begun, as `{message, kind, ref}`. A batch's own `queued` lists the
 * `{kind, args}` of the writes queued on it.
 *
 * What it does not do: keep any state. A write is answered, not applied, and
 * a later read answers what `answer` says. Nor does it learn document
 * versions, lose a lock, retry, or check that an id exists.
 *
 * `timed` and `withinFactorOf` bound a slow case against a small one timed
 * in the same run, where a fixed number of milliseconds fails on a loaded
 * runner. Their twins are `timed` and `within_factor_of` in
 * `plaid_client.testing` and in plaid-core's `plaid.test-helpers`.
 */

import { BatchRef } from "./batchRef.js";
import { PlaidClient } from "./client.js";
import { prepareRequest } from "./http.js";
import { uuidv7 } from "./ids.js";
import { applyMetadataOps } from "./metadataOps.js";

/**
 * A request as `answer` is asked it: the bundle call that made it (`kind` and
 * `args`), and the request as the server reads it.
 * @typedef {{kind?: string, args: any[], method: string, path: string,
 *   query: Record<string, string>, body: any, batched: boolean}} FakeRequest
 */

/**
 * A round trip as `requests` holds it and `onRequest` hears it: a request,
 * or a batch request with its `operations`.
 * @typedef {{method: string, path: string, query: Record<string, string>, body: any,
 *   kind?: string, args?: any[], operations?: object[]}} RecordedRequest
 */

/**
 * An error as the client throws it for a refusal: `status`, and the
 * server's answer as `responseData`.
 * @param {number} status
 * @param {object} [responseData]
 * @returns {Error & {status: number, responseData: object}}
 */
export function refusal(status, responseData = {}) {
  const error = /** @type {any} */ (
    new Error(`HTTP ${status} ${responseData.error || responseData.message || "Refused"}`)
  );
  error.status = status;
  error.responseData = responseData;
  return error;
}

// What the server refuses whoever sends it: a metadata patch, alone or as an
// entry of a bulk update, that is not a list of ops.
function checkMetadataOps(ops) {
  if (!Array.isArray(ops)) throw refusal(400, { error: "metadata ops must be an array" });
  applyMetadataOps({}, ops);
}

function serverChecks(kind, args) {
  if (!kind) return;
  if (kind.endsWith(".patchMetadata")) checkMetadataOps(args[1]);
  if (kind.endsWith(".bulkUpdate")) {
    for (const entry of args[0] || []) {
      if (entry?.metadata !== undefined) checkMetadataOps(entry.metadata);
    }
  }
}

/**
 * What a request is answered with when `answer` gives nothing: the id a
 * create minted (or a new one), the ids of a bulk create, an empty page for a
 * read, and `{}` for anything else.
 * @param {{kind?: string, method: string, body?: any}} request
 * @returns {object}
 */
export function defaultAnswer({ kind, method, body }) {
  if (kind?.endsWith(".bulkCreate") && Array.isArray(body)) {
    return { ids: body.map((entry) => entry?.id ?? uuidv7()) };
  }
  if (/\.(create|copy|split)$/.test(kind ?? "")) return { id: body?.id ?? uuidv7() };
  if (method === "GET") return { entries: [], nextCursor: null };
  return {};
}

const isPlainObject = (v) => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// The id a ref stands for, read off the results its batch has so far.
const refId = (results, ref) => {
  const body = results[ref.$ref]?.body;
  return ref.index === undefined ? body?.id : body?.ids?.[ref.index];
};

// `args` with each BatchRef in it replaced by the id it stands for.
const fillArgs = (args, results) => {
  const fill = (v) => {
    if (v instanceof BatchRef) return refId(results, v);
    if (Array.isArray(v)) return v.map(fill);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return args.map(fill);
};

// A queued op's body with the ids its `refs` name put in, as the server does.
const fillRefs = (body, refs, results) => {
  if (!refs) return body;
  const out = structuredClone(body);
  for (const { at, op, index } of refs) {
    let holder = out;
    for (const key of at.slice(0, -1)) holder = holder[key];
    holder[at.at(-1)] = refId(results, { $ref: op, index });
  }
  return out;
};

const split = (url, baseUrl) => {
  const u = new URL(url.startsWith("http") ? url : `${baseUrl}${url}`);
  return { path: u.pathname, query: Object.fromEntries(u.searchParams) };
};

// What goes over the wire is JSON: a value that cannot be (a BatchRef sent
// anywhere but a queued body) throws here as it would there.
const wire = (body) => (body === undefined ? undefined : JSON.parse(JSON.stringify(body)));

/**
 * A real PlaidClient on a recording transport (see the module's note).
 *
 * `answer(request)` answers each request, `request` being `{kind, args,
 * method, path, query, body, batched}`: the bundle call that made it (`kind`
 * and `args`, any batch refs in them filled in, undefined for a request no
 * bundle call made), and the request as the server reads it. It returns the
 * answer as the client hands it back (camelCase), or a promise of it, or
 * undefined for `defaultAnswer`'s. To refuse, it throws (see `refusal`). A
 * refusal of any op of a batch refuses the whole batch, as the server's
 * transaction does.
 *
 * @param {{answer?: (request: FakeRequest) => any,
 *   onRequest?: (request: RecordedRequest) => void, baseUrl?: string}} [options]
 * @returns {PlaidClient & {calls: Array<{kind: string, args: any[]}>,
 *   requests: RecordedRequest[], operations: Array<{message: string, kind?: string, ref?: string}>}}
 */
export function fakeClient({
  answer = () => undefined,
  onRequest = () => {},
  baseUrl = "http://plaid.test",
} = {}) {
  // A token of its own: each fake client is a login of its own, so nothing
  // kept per login (a cache an app keeps by token) is shared between tests.
  const token = `test-token-${uuidv7()}`;
  const client = /** @type {any} */ (new PlaidClient(baseUrl, token, { retryDelaysMs: [] }));
  const calls = [];
  const requests = [];
  const operations = [];
  client.calls = calls;
  client.requests = requests;
  client.operations = operations;

  // The bundle call being made, while its request is formed.
  let current = null;
  // Each queued op's call and batch, read when the batch is sent.
  const callOf = new WeakMap();
  // Each batch's results so far, for the refs its later ops hold.
  const resultsOf = new WeakMap();

  const respond = async (request) => {
    serverChecks(request.kind, request.args);
    const given = await answer(request);
    return given === undefined ? defaultAnswer(request) : given;
  };

  // The call being made sees its request: it is recorded when the request
  // is no read.
  const seen = (method) => {
    if (!current || current.recorded) return current;
    current.recorded = true;
    if (method !== "GET") calls.push({ kind: current.kind, args: current.args });
    return current;
  };

  client._request = async (method, path, options = {}) => {
    // What the real client refuses before anything goes (a write on a lock
    // that lapsed) is refused here, and was never made.
    const { url, requestBody, stampedGroup } = prepareRequest(client, method, path, options);
    const call = seen(method);
    const body = options.formData ? requestBody : wire(requestBody);
    const request = { method, ...split(url, baseUrl), body, kind: call?.kind, args: call?.args ?? [] };
    requests.push(request);
    onRequest(request);
    const answered = await respond({ ...request, batched: false });
    // The server took it, so the operation's group exists.
    if (stampedGroup) stampedGroup.written = true;
    return answered;
  };

  client._postBatch = async (url, chunk) => {
    const sent = wire(chunk);
    const request = { method: "POST", ...split(url, baseUrl), body: undefined, operations: sent };
    requests.push(request);
    onRequest(request);
    const answered = [];
    for (let i = 0; i < chunk.length; i++) {
      const op = chunk[i];
      const { call, batch } = callOf.get(op) ?? callOf.get(op.body) ?? {};
      const results = (batch && resultsOf.get(batch)) ?? [];
      const body = fillRefs(sent[i].body, op.refs, answered);
      const result = await respond({
        kind: call?.kind,
        args: call ? fillArgs(call.args, results) : [],
        method: op.method,
        ...split(op.path, baseUrl),
        body,
        batched: true,
      });
      const entry = { status: 200, headers: {}, body: result };
      answered.push(entry);
      results.push(entry);
    }
    return answered;
  };

  // Each bundle method on `view` (the client, or a batch) tells the
  // transport which call is being made.
  const instrument = (view) => {
    const queued = [];
    for (const [name, bundle] of Object.entries(view)) {
      if (name === "client" || !isPlainObject(bundle)) continue;
      for (const [method, fn] of Object.entries(bundle)) {
        if (typeof fn !== "function") continue;
        bundle[method] = tracked(view, `${name}.${method}`, fn, queued);
      }
    }
    if (typeof view.query === "function") view.query = tracked(view, "query", view.query, queued);
    return queued;
  };

  function tracked(view, kind, fn, queued) {
    return function (...args) {
      const call = { kind, args, recorded: false };
      const ops = view === client ? null : view.operations;
      const before = ops?.length;
      const outer = current;
      current = call;
      try {
        return fn.apply(this, args);
      } finally {
        current = outer;
        // A write the call queued on a batch.
        if (ops && ops.length > before) {
          if (!call.recorded) {
            call.recorded = true;
            calls.push({ kind, args });
          }
          queued.push({ kind, args });
          for (const op of ops.slice(before)) {
            callOf.set(op, { call, batch: view });
            if (op.body && typeof op.body === "object") callOf.set(op.body, { call, batch: view });
          }
        }
      }
    };
  }

  instrument(client);

  client.batch = (options) => {
    const b = PlaidClient.prototype.batch.call(client, options);
    resultsOf.set(b, []);
    b.queued = instrument(b);
    const submit = b.submit;
    b.submit = () => {
      calls.push({ kind: "batch.submit", args: [] });
      return submit();
    };
    return b;
  };

  client.beginOperation = function (message, opts = {}) {
    if (!this.operationGroup) {
      const tags = {
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.ref ? { ref: opts.ref } : {}),
      };
      const id = PlaidClient.prototype.beginOperation.call(this, message, opts);
      calls.push({
        kind: "beginOperation",
        args: Object.keys(tags).length ? [message, tags] : [message],
      });
      operations.push({ message, kind: opts.kind, ref: opts.ref });
      return id;
    }
    return PlaidClient.prototype.beginOperation.call(this, message, opts);
  };

  return client;
}

/**
 * Runs `f` and gives its value and the milliseconds it took. With `warm`,
 * runs it that many times first, untimed, so the engine has compiled it.
 * With `runs`, times that many runs and keeps the quickest, which a pause for
 * garbage collection or another process touches least. Only for an `f` that
 * can run again.
 * @template T
 * @param {() => T} f
 * @param {{warm?: number, runs?: number}} [options]
 * @returns {[T, number]}
 */
export function timed(f, { warm = 0, runs = 1 } = {}) {
  for (let i = 0; i < warm; i++) f();
  /** @type {[T, number] | null} */
  let best = null;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const value = f();
    const ms = performance.now() - t;
    if (!best || ms < best[1]) best = [value, ms];
  }
  return /** @type {[T, number]} */ (best);
}

/**
 * Throws unless `bigMs` is under `factor` times `smallMs`, two cases timed on
 * the same machine in the same run. A loaded runner slows both, so the bound
 * holds where a fixed number of milliseconds fails. Pick the cases so that
 * the fault the test guards against grows the ratio well past `factor`: a
 * scan of every row per row goes from 10 to 100 when the big case is ten
 * times the small one. `smallMs` counts as at least `floorMs` (default 1),
 * so a case too quick to time cannot make the bound nothing.
 * @param {number} factor
 * @param {number} smallMs
 * @param {number} bigMs
 * @param {{floorMs?: number, label?: string}} [options]
 * @returns {number} `bigMs`
 */
export function withinFactorOf(factor, smallMs, bigMs, { floorMs = 1, label } = {}) {
  if (!(bigMs < factor * Math.max(smallMs, floorMs))) {
    throw new Error(
      `${label ? `${label}: ` : ""}${Math.round(bigMs)} ms, not under ${factor} times ` +
        `the small case's ${Math.round(smallMs)} ms`,
    );
  }
  return bigMs;
}
