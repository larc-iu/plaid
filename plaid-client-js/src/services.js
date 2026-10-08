/**
 * Service coordination: discovery + server-mediated request/response RPC.
 *
 * All of this runs OFF the broadcast bus (`/listen` + `/message`). A service is
 * present exactly while its inbound request channel (SSE) is open — that
 * channel is the registration; there is no separate registry or heartbeat.
 * Discovery is a synchronous GET. Work requests are addressed: a service
 * receives them on its channel and reports back via plain POSTs that the
 * server relays to the one waiting requester.
 */
import { transformRequest, transformResponse } from './transforms.js';

// An absolute URL anywhere in an error message, with the phrase that introduces
// it (`... at http://host/api/v1/spans`). Client and transport errors name the
// endpoint they called, which is the service operator's business and not the
// requester's.
const URL_IN_TEXT = /(?:\s+(?:at|for url:?))?\s*\b[a-zA-Z][\w+.-]*:\/\/\S+/g;

/**
 * What a requester is told when an error carries no message of its own.
 * Naming the JS class instead would say nothing they can act on.
 */
export const UNKNOWN_FAILURE = 'The service could not finish this request.';

const redact = (text, secrets) => {
  let out = text;
  for (const secret of secrets || []) {
    if (secret && String(secret).length >= 8) out = out.split(String(secret)).join('[redacted]');
  }
  return out.trim();
};

/** A write sent to the server whose answer never came back. */
export const UNKNOWN_OUTCOME =
  'The Plaid server did not answer. This change may or may not have been saved.';

/** The server was never reached, so nothing was sent. */
export const UNREACHABLE = 'The Plaid server could not be reached.';

// A few reads travel as a POST, and saved nothing either way (the Python twin
// and plaid-ui's errors.js keep the same list).
const READ_POSTS = /\/api\/v1\/(?:query|login|invites\/lookup)(?:[?#]|$)/;

// Node's fetch (undici) names a connection that never opened by its code: a
// refused port, a name that did not resolve, a connect timeout. Nothing was
// sent then. A browser's fetch says only "Failed to fetch", which cannot be
// told apart from a reset, so it counts as sent.
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const neverConnected = (error) => {
  const seen = new Set();
  let cause = error && error.originalError;
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    if (NEVER_CONNECTED.has(cause.code)) return true;
    cause = cause.cause;
  }
  return false;
};

const networkFailure = (error) => {
  const method = String(error.method || '').toUpperCase();
  if (neverConnected(error)) return UNREACHABLE;
  if (method && method !== 'GET' && method !== 'HEAD' && !READ_POSTS.test(String(error.url || ''))) {
    return UNKNOWN_OUTCOME;
  }
  return 'The Plaid server did not answer.';
};

/**
 * One line about a failure that is safe to show the person who asked.
 *
 * Strips absolute URLs (so an internal host never reaches a requester's screen)
 * and any `secrets` given (a model provider's API key can come back inside its
 * own error text). The whole error still goes to the operator's console: this
 * is the requester's half only. The Python twin is `requester_message`.
 *
 * Only a connection that never opened is "could not be reached". A write whose
 * answer never came (a reset, a timeout) may have been saved, and says so
 * (`UNKNOWN_OUTCOME`).
 *
 * @param {any} error
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function requesterMessage(error, secrets = []) {
  if (error && typeof error.status === 'number') {
    if (!error.status) return networkFailure(error);
    let text = String(error.message || '');
    if (error.url) text = text.split(` at ${error.url}`).join('').split(error.url).join('');
    text = text.trim().replace(/[\s,:;]+$/, '');
    return redact(text, secrets) || `HTTP ${error.status}`;
  }
  // An Error is read by its message and nothing else: `String(new TypeError(''))`
  // is 'TypeError', which names the class to the requester and tells them
  // nothing they can act on.
  const raw =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message ?? '')
      : String(error ?? '');
  const text = raw.replace(URL_IN_TEXT, '').trim().replace(/[\s,:;]+$/, '');
  return redact(text, secrets) || UNKNOWN_FAILURE;
}

/**
 * What the requester is told when a request fails, named by the service.
 *
 * Every path that reports a failed request goes through here, so a raw message
 * cannot reach a requester from one of them. (Python's twin additionally lets a
 * `ValueError` through unprefixed, as an authored refusal; JS has no
 * distinguished refusal type, so every failure is named by the service.)
 *
 * @param {any} error
 * @param {string} [serviceName]
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function serviceErrorMessage(error, serviceName = '', secrets = []) {
  const text = requesterMessage(error, secrets);
  return serviceName ? `${serviceName}: ${text}` : text;
}

/**
 * Discover the services seen on a project — a synchronous GET. Returns every
 * service ever registered on the project: currently connected ones carry
 * `online: true`; previously-seen offline ones carry `online: false` plus a
 * `lastSeenAt` stamp. Callers that need a service they can actually submit
 * work to should filter on `online`. A connected service also names who runs
 * it, as the caller sees it: `runnerName` (the runner's display name),
 * `runByYou`, and `servesYou`, whether it would take the caller's requests on
 * this project. A delegating service serves members other than its runner
 * only where the runner is a maintainer or an admin. Goes over the wire even
 * while a batch is open on the client.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @returns {Promise<Array>} [{serviceId, serviceName, description, extras, online, lastSeenAt, runnerName, runByYou, servesYou}]
 */
export function discoverServices(client, projectId) {
  return client._request('GET', `/api/v1/projects/${projectId}/services`);
}

/**
 * Forget a previously-seen (offline) service: removes its row from the
 * project's persistent registry. Maintainer-only; 409 if the service is
 * currently connected (it would just re-register).
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {string} serviceId - Service ID to forget
 * @returns {Promise<void>}
 */
export function discardService(client, projectId, serviceId) {
  // outOfBand: the registry is not project data (see the note at the top of
  // http.js).
  return client._request('DELETE', `/api/v1/projects/${projectId}/services/${encodeURIComponent(serviceId)}`, {
    outOfBand: true,
  });
}

/**
 * POST a progress, result or error event for an in-flight request; the server
 * relays it to the waiting requester. The Python twin is `_report_event`.
 *
 * outOfBand: these are signals to whoever is waiting, not writes to the
 * project (see the note at the top of http.js). A service may report them on
 * the batch it is filling, where queueing them would hold every one back until
 * submit, deliver none at all if the batch aborts, and take slots in the
 * batch's results. The requester would hear nothing and wait out its idle
 * timeout on work that had already finished.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {string} requestId - The request id
 * @param {Object} body - The event payload
 * @returns {Promise<any>}
 */
export function reportRequestEvent(client, projectId, requestId, body) {
  return client._request(
    'POST',
    `/api/v1/projects/${projectId}/service-requests/${encodeURIComponent(requestId)}/events`,
    { body, outOfBand: true },
  );
}

/**
 * HTTP statuses a refused service channel answers with that retrying cannot
 * fix: a bad or revoked token, no write access to the project, a project that
 * does not exist. The same set as the Python client's.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

/**
 * Register a service and handle incoming work requests.
 *
 * Opens the service's dedicated request channel — which registers it for
 * discovery (presence = open channel) — and handles work on it. For each
 * request, runs `onServiceRequest(data, responseHelper)` where `responseHelper`
 * has `progress(percent, msg)` / `complete(data)` / `error(err)`.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {Object} serviceInfo - {serviceId, serviceName, description}
 * @param {function} onServiceRequest - Handler callback (data, responseHelper)
 * @param {Object} extras - Optional additional metadata
 * @param {function} [onStatus] - Optional callback (event, projectId, detail) for
 *   connection-state transitions: 'registered', 'reconnected', 'disconnected',
 *   and 'stopped' when the server refuses the channel for a reason retrying
 *   cannot fix (see PERMANENT_STATUSES), which ends the registration.
 *   Called once per transition, not once per retry.
 * @returns {Object} ServiceRegistration with .stop(), .isRunning(), .isConnected(),
 *   .serviceInfo
 */
export function serve(client, projectId, serviceInfo, onServiceRequest, extras = {}, onStatus = null) {
  const { serviceId, serviceName, description = '' } = serviceInfo;
  let connection = null;
  let isRunning = true;
  let reconnectTimer = null;
  // Last state REPORTED, so an outage produces one "lost" line and one "back"
  // line however many retries it took.
  let isConnected = false;
  let everConnected = false;

  const report = (event, detail) => {
    if (!onStatus) return;
    try { onStatus(event, projectId, detail); } catch (_) { /* never disturb the loop */ }
  };
  const noteConnected = () => {
    if (isConnected) return;
    const first = !everConnected;
    isConnected = true;
    everConnected = true;
    report(first ? 'registered' : 'reconnected');
  };
  const noteDisconnected = () => {
    if (!isConnected) return;
    isConnected = false;
    report('disconnected');
  };

  const reportEvent = (requestId, body) =>
    reportRequestEvent(client, projectId, requestId, body).catch((error) => {
      // 404 just means the requester already went away; nothing to do.
      console.warn('Failed to report request event:', error.message || error);
    });

  const serviceRegistration = {
    stop: () => {
      isRunning = false;
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
      // Closing the channel deregisters the service server-side.
      if (connection) connection.close();
    },
    isRunning: () => isRunning,
    // Whether the request channel is open RIGHT NOW, i.e. whether the server
    // currently sees this service as online. A registration that is retrying
    // through a server restart is still running but not connected.
    isConnected: () => isRunning && !!connection && connection.readyState === 1,
    serviceInfo: { serviceId, serviceName, description, extras },
  };

  // Discovery metadata rides the channel's query string — opening the channel
  // is the registration. Keep wire keys kebab-case (transform extras too) so
  // they round-trip like the rest of the API.
  const params = new URLSearchParams();
  if (serviceName) params.set('service-name', serviceName);
  if (description) params.set('description', description);
  if (extras && Object.keys(extras).length) params.set('extras', JSON.stringify(transformRequest(extras)));
  const qs = params.toString();
  const channelPath = `/api/v1/projects/${projectId}/services/${encodeURIComponent(serviceId)}/requests${qs ? `?${qs}` : ''}`;

  // The requests this channel is serving, by id, each flagged once a
  // `service_cancel` arrives. The handler reads it as `responseHelper.cancelled`;
  // whether to stop is the handler's decision (a write under way should
  // finish), and the request still ends with whatever it reports.
  const cancelled = new Map();

  // Beyond `connected` (ignored), the channel carries `service_request` and
  // `service_cancel` events.
  const onChannelEvent = (eventType, payload) => {
    if (!isRunning) return true;
    if (!payload) return;
    if (eventType === 'service_cancel') {
      if (cancelled.has(payload.requestId)) cancelled.set(payload.requestId, true);
      return;
    }
    if (eventType !== 'service_request') return;
    const requestId = payload.requestId;
    if (!requestId) return;
    cancelled.set(requestId, false);
    const finished = () => cancelled.delete(requestId);

    // Every service is told who asked (`requesterId`), beside the payload
    // when that is a plain object, and on the helper regardless. A delegating
    // service (extras `delegation: true`) also gets a short-lived token for the
    // requesting user (`delegatedToken`) and the projects that token reaches
    // (`delegatedProjects`, the request's own first), as the Python client
    // hands them over.
    const requesterId = payload.requesterId || null;
    const extra = {
      ...(requesterId ? { requesterId } : {}),
      ...(payload.delegatedToken ? { delegatedToken: payload.delegatedToken } : {}),
      ...(payload.delegatedProjects ? { delegatedProjects: payload.delegatedProjects } : {}),
    };
    const data =
      Object.keys(extra).length && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? { ...payload.data, ...extra }
        : payload.data;

    const scope = createCancelScope(() => cancelled.get(requestId) === true);
    const responseHelper = {
      requestId,
      requesterId,
      // True once the requester asked for the request to stop.
      get cancelled() {
        return scope.cancelled;
      },
      raiseIfCancelled: () => scope.raiseIfCancelled(),
      critical: (fn) => scope.critical(fn),
      // Extra fields ride in the progress payload (a chat service sends the
      // reply text so far as `text`).
      //
      // This is a CANCELLATION CHECKPOINT: it throws ServiceCancelled if the
      // requester has stopped the request, so a service that reports progress
      // through its work is cancellable without doing anything else. Use
      // `critical()` around writes to hold it off.
      progress: (percent, msg, extra) => {
        scope.raiseIfCancelled();
        return reportEvent(requestId, {
          status: 'progress',
          progress: { percent, message: msg, ...extra },
        });
      },
      complete: (data) => {
        finished();
        return reportEvent(requestId, { status: 'completed', data });
      },
      // Asked to stop, and it did. Reported as a result carrying
      // `stopped: true`, so a client can tell "you stopped it" from "it broke".
      stopped: (data) => {
        finished();
        return reportEvent(requestId, {
          status: 'completed',
          data: { ...(data || {}), stopped: true },
        });
      },
      // Every failure a requester is shown goes out through here, whoever
      // reports it, so the scrub lives here rather than only in `settle`: a
      // service that catches its own error and calls `helper.error(err)`
      // would otherwise put the endpoint the client called on the requester's
      // screen. Already-sanitized text passes through unchanged.
      error: (error) => {
        finished();
        return reportEvent(requestId, {
          status: 'error',
          data: { error: requesterMessage(error) },
        });
      },
    };

    // A handler may be async, so a rejected promise has to be caught too, or a
    // cancelled async service would report a failure instead of a stop.
    const settle = (error) => {
      if (error instanceof ServiceCancelled || error?.name === 'ServiceCancelled') {
        responseHelper.stopped();
      } else {
        // What reaches the requester is the sanitized half: the raw message
        // names the endpoint the client called, which is the operator's
        // business. The console keeps the whole error.
        console.error(`Service ${serviceId} failed request ${requestId}:`, error);
        responseHelper.error(serviceErrorMessage(error, serviceName));
      }
    };
    try {
      const maybe = onServiceRequest(data, responseHelper);
      if (maybe && typeof maybe.catch === 'function') maybe.catch(settle);
    } catch (error) {
      settle(error);
    }
  };
  const openChannel = () => client.messages.listen(projectId, onChannelEvent, channelPath);
  try {
    connection = openChannel();
  } catch (error) {
    throw new Error(`Failed to start service: ${error.message}`);
  }

  // Reopen the channel whenever it drops (e.g. the server restarted), for as
  // long as the service runs. Reopening re-registers the service server-side,
  // so presence and reachability come back together, and a server restart never
  // means a service restart. A reopened channel counts as connected only once
  // the server has actually answered it (readyState OPEN), not merely because
  // the attempt was made.
  //
  // A channel the server REFUSED for a reason retrying cannot fix (the token
  // was revoked, the user lost write access, the project is gone) ends the
  // registration instead: the server closes a channel whose opener lost the
  // right to it, and reopening it every few seconds forever would only hide
  // that from the operator.
  reconnectTimer = setInterval(() => {
    if (!isRunning || !connection) return;
    if (connection.readyState === 1) { noteConnected(); return; }
    if (connection.readyState === 2) { // CLOSED (dropped or failed)
      const status = connection.error?.status;
      if (PERMANENT_STATUSES.has(status)) {
        noteDisconnected();
        serviceRegistration.stop();
        report('stopped', `HTTP ${status}`);
        return;
      }
      noteDisconnected();
      try { connection = openChannel(); } catch (_) { /* retry next tick */ }
    }
  }, 3000);

  return serviceRegistration;
}

/**
 * Submit work to a service and await its result.
 *
 * Streams the service's progress + result back over a single server-mediated
 * response (no broadcast). Rejects if no service is connected (503), if the
 * service reports an error, or after `timeout` of SILENCE.
 *
 * The request outlives this call: after a timeout, an abort, or a dropped
 * connection the service goes on, and `attachServiceRequest` collects the
 * result given the request id, which `opts.onAccepted` receives as soon as
 * the server has taken the request. Pass `opts.requestId` (a UUID you mint)
 * to know the id before submitting; submitting an id that names a request
 * you already made rejoins it instead of starting another.
 *
 * Errors that leave the request alive carry `pending: true`: a timeout, a
 * stop, a dropped connection, a proxy's 502 or 504. An error without it is
 * the end of the request. With `opts.requestId`, a request whose answer went
 * missing (a dropped connection, a 502 or 504) is rejoined by that id a few
 * times before the error is given.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {string} serviceId - Service ID to request
 * @param {any} data - Request payload
 * @param {number} [timeout=10000] - How long the service may say NOTHING, in ms.
 *   Every event it sends starts the clock again, so this does not cap a long run.
 *   0, a negative number or null: no limit (wait until `signal` stops it)
 * @param {function} [onProgress] - Called with each progress payload {percent, message}
 * @param {AbortSignal} [signal] - Abort to stop waiting; rejects with an AbortError
 * @param {Object} [opts]
 * @param {string} [opts.requestId] - A client-minted request id (UUID)
 * @param {function} [opts.onAccepted] - Called with the request id once the server has it
 * @param {string[]} [opts.projectIds] - Other projects the request is about, beside
 *   `projectId`. A delegating service's token is scoped to `projectId` and to those of
 *   these the requester can read, and reaches nothing else
 * @param {boolean} [opts.noOperation] - Carry no open operation: the service's writes
 *   are a group of their own, not part of whatever operation this client has open
 * @returns {Promise<any>} The service's result
 */
export function requestService(client, projectId, serviceId, data, timeout = 10000, onProgress, signal, opts = {}) {
  // Propagate an open logical operation (client.beginOperation) to the
  // service: its writes then fold under the requester's audit-log entry
  // (the Python BaseService adopts the id around process_request). Only for a
  // plain-object payload — that's the only shape the service param schema
  // delivers anyway.
  // Its kind and reference go too, so a service that writes before the
  // requester does still records them.
  //
  // `opts.noOperation` sends none: the service starts a group of its own. For
  // a request that is its own action whatever else is on the wire, such as
  // approving an assistant's plan or starting a service run. The client holds
  // one open operation, so without it an edit still saving at that moment
  // would take in every write the request makes, under the edit's kind.
  const group = opts.noOperation ? null : client.operationGroup;
  const payload =
    group && data && typeof data === 'object' && !Array.isArray(data)
      ? {
          ...data,
          operationGroup: {
            id: group.id,
            message: group.message,
            ...(group.kind ? { kind: group.kind } : {}),
            ...(group.ref ? { ref: group.ref } : {}),
          },
        }
      : data;
  const query = new URLSearchParams();
  if (opts.requestId) query.set('request-id', opts.requestId);
  if (opts.projectIds?.length) query.set('project-ids', opts.projectIds.join(','));
  const qs = String(query) ? `?${query}` : '';
  const submit = () => streamServiceRequest(
    client,
    {
      url: `${client.baseUrl}/api/v1/projects/${projectId}/services/${encodeURIComponent(serviceId)}/requests${qs}`,
      method: 'POST',
      body: JSON.stringify(payload === undefined ? null : transformRequest(payload)),
      // `notLive` (with `serviceId`) lets an app say it in the service's own
      // name rather than its id.
      onStatus: (response) =>
        response.status === 503
          ? Object.assign(new Error(`No live service '${serviceId}' on this project`), {
              notLive: true,
              serviceId,
            })
          : null,
      what: 'Service request',
    },
    timeout,
    onProgress,
    signal,
    opts.onAccepted,
  );
  // A request whose id is known is rejoined when its answer goes missing, so
  // a run the service took and finished is not reported failed.
  if (!opts.requestId) return submit();
  return rejoinLost(
    submit,
    () => attachServiceRequest(client, projectId, opts.requestId, timeout, onProgress, signal),
    signal,
  );
}

/**
 * Rejoin a service request made earlier (by this user) and await its result:
 * the latest progress is replayed, then the result comes, or at once if the
 * request already finished. Rejects with an error whose `status` is 404 when
 * the request is unknown or expired (the server keeps a finished request's
 * result for a while, not forever). As with `requestService`, `timeout` is
 * how long the service may be silent, and an error carrying `pending: true`
 * means the request is still there to rejoin again.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {string} requestId - The request id (from `onAccepted` or your own)
 * @param {number} [timeout=10000] - How long the service may say NOTHING, in ms
 *   (0, a negative number or null: no limit)
 * @param {function} [onProgress] - Called with each progress payload {percent, message}
 * @param {AbortSignal} [signal] - Abort to stop waiting; rejects with an AbortError
 * @returns {Promise<any>} The service's result
 */
export function attachServiceRequest(client, projectId, requestId, timeout = 10000, onProgress, signal) {
  return streamServiceRequest(
    client,
    {
      url: `${client.baseUrl}/api/v1/projects/${projectId}/service-requests/${encodeURIComponent(requestId)}`,
      method: 'GET',
      what: 'Attach to service request',
    },
    timeout,
    onProgress,
    signal,
  );
}

/**
 * Thrown inside a handler when the requester has asked it to stop.
 *
 * Cooperative cancellation: nothing interrupts a handler, so the request ends
 * at the next point the handler looks. `responseHelper.progress` is that
 * point, which is why a long service that already reports progress needs no
 * changes at all. `serve` catches this and ends the request as STOPPED rather
 * than failed.
 */
export class ServiceCancelled extends Error {
  constructor(message = 'The requester stopped this request') {
    super(message);
    this.name = 'ServiceCancelled';
  }
}

/**
 * The cancellation half of a responseHelper: a flag, a depth counter, and one
 * rule about when a checkpoint may raise. Split from the transport so it can
 * be reasoned about on its own. Mirrors `CancelScope` in the Python client.
 */
export function createCancelScope(isCancelled) {
  // Depth of nested `critical()` blocks; while non-zero, a checkpoint will
  // not throw.
  let criticalDepth = 0;
  return {
    get cancelled() {
      return !!isCancelled();
    },
    /** Stop here if the requester has asked the request to stop. */
    raiseIfCancelled() {
      if (isCancelled() && criticalDepth === 0) throw new ServiceCancelled();
    },
    /**
     * Run `fn` as a stretch that must finish once begun, usually the writes.
     * Checkpoints inside do not throw, so a half-written document is never
     * left behind; cancellation takes effect at the first checkpoint after.
     */
    async critical(fn) {
      criticalDepth++;
      try {
        return await fn();
      } finally {
        criticalDepth--;
      }
    },
  };
}

/**
 * Ask the service to stop a request made earlier (by this user). The request
 * still ends with whatever the service then reports, on the stream of whoever
 * is awaiting it. Rejects with 404 if unknown or expired, 409 once finished.
 *
 * outOfBand: a DELETE, but not a write. It signals a running service and
 * changes no project data (see the note at the top of http.js).
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {string} requestId - The request id
 * @returns {Promise<void>}
 */
export function cancelServiceRequest(client, projectId, requestId) {
  return client._request(
    'DELETE',
    `/api/v1/projects/${projectId}/service-requests/${encodeURIComponent(requestId)}`,
    { outOfBand: true },
  );
}

/**
 * Mark an error as one that leaves the request ALIVE on the server: a timeout,
 * a stop, a dropped connection. The service goes on working and its result
 * still waits under the request id, so a caller holding that id can rejoin it
 * with `attachServiceRequest`, and must not forget the id the way it forgets
 * a request that really ended. An error without `pending` is terminal.
 */
const stillRunning = (err) => Object.assign(err, { pending: true });

/**
 * A still-running error whose cause is that the ANSWER went missing: the
 * request could not be sent or read to its end, or a proxy answered for the
 * server (502, 504). Not a timeout or a stop, which are the caller's own
 * choice to stop waiting. A submit whose answer was lost rejoins its request
 * (`rejoinLost`).
 */
const lostAnswer = (err) => Object.assign(stillRunning(err), { lostAnswer: true });

/** How long to wait before each attempt to rejoin a request whose answer was lost. */
const REJOIN_DELAYS_MS = [1000, 3000, 9000];

const delay = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * `submit()` again, by attaching to the request `requestId` names, while its
 * answer is the one that went missing. The request was taken, or never
 * reached the server: attaching follows a taken one to its end, and a 404
 * says the server never had it, so the first error stands. Each attempt
 * whose answer goes missing too waits a little longer before the next.
 */
async function rejoinLost(submit, attach, signal) {
  let first;
  try {
    return await submit();
  } catch (err) {
    if (!err?.lostAnswer) throw err;
    first = err;
  }
  let last = first;
  for (const ms of REJOIN_DELAYS_MS) {
    await delay(ms, signal);
    if (signal?.aborted) throw last;
    try {
      return await attach();
    } catch (err) {
      if (err?.status === 404) throw first;
      if (!err?.lostAnswer) throw err;
      last = err;
    }
  }
  throw last;
}

/**
 * Open a request stream (submit or attach) and read it to its terminal
 * event: `accepted` names the request, `progress` events go to `onProgress`,
 * and `result` / `error` settle the promise.
 */
function streamServiceRequest(client, { url, method, body, onStatus, what }, timeout, onProgress, signal, onAccepted) {
  return new Promise((resolve, reject) => {
    const abortController = new AbortController();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortController.abort();
      fn(arg);
    };

    // `timeout` is IDLE time, meaning how long the service may say nothing. It
    // is not a deadline on the run: every event from the server restarts it,
    // because a service that is reporting its progress is not hung. As a
    // deadline on the whole run it killed working transcriptions at the
    // five-minute default and left their writes to land on a document the page
    // had already handed back to the user as editable.
    // 0, a negative number or null is no limit, as for every other timeout.
    let timer;
    const waitAgain = () => {
      clearTimeout(timer);
      if (!(timeout > 0)) return;
      timer = setTimeout(
        () =>
          finish(reject, stillRunning(new Error(`${what} timed out after ${timeout}ms of silence`))),
        timeout,
      );
    };
    waitAgain();

    // An external signal stops waiting on a long request (a UI's Stop button).
    // Reject with an AbortError so a caller can tell a deliberate stop from a
    // failure. The service is not told here: it goes on, and its result can
    // still be collected by request id (see cancelServiceRequest to stop it).
    const stop = () => {
      const err = new Error('The service request was stopped');
      err.name = 'AbortError';
      finish(reject, stillRunning(err));
    };
    if (signal) {
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener('abort', stop, { once: true });
    }

    (async () => {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${client.token}`,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          ...(body === undefined ? {} : { body }),
          signal: abortController.signal,
        });
      } catch (error) {
        // The POST may or may not have reached the server. Treat it as alive:
        // rejoining a request that was never made simply 404s.
        if (error.name !== 'AbortError') finish(reject, lostAnswer(new Error(`${what} could not be sent: ${error.message}`)));
        return;
      }

      const special = onStatus ? onStatus(response) : null;
      if (special) {
        finish(reject, special);
        return;
      }
      if (!response.ok) {
        // A refusal says why in its body (`{error}`), as on every other route.
        let said = null;
        try {
          said = await response.json();
        } catch {
          said = null;
        }
        const why = typeof said?.error === 'string' ? `: ${said.error}` : '';
        const err = new Error(`${what} failed: HTTP ${response.status} ${response.statusText}${why}`);
        err.status = response.status;
        if (said && typeof said === 'object') err.responseData = said;
        // A proxy's 502 or 504 is no answer from the server: the request may
        // have been taken, and the service may be running it.
        finish(reject, response.status === 502 || response.status === 504 ? lostAnswer(err) : err);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';
      let dataLine = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || settled) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const rawLine of lines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              dataLine = line.slice(6);
            } else if (line === '' && eventType && dataLine) {
              const payload = transformResponse(JSON.parse(dataLine));
              waitAgain(); // it spoke, so it is not hung
              if (eventType === 'accepted') {
                if (onAccepted) { try { onAccepted(payload.requestId); } catch (_) { /* ignore */ } }
              } else if (eventType === 'progress') {
                if (onProgress) { try { onProgress(payload.progress); } catch (_) { /* ignore */ } }
              } else if (eventType === 'result') {
                finish(resolve, payload.data);
                return;
              } else if (eventType === 'error') {
                finish(reject, new Error(payload?.error || `${what} failed`));
                return;
              }
              eventType = '';
              dataLine = '';
            }
          }
        }
        finish(reject, lostAnswer(new Error('Service closed the connection without a result')));
      } catch (error) {
        if (error.name !== 'AbortError') finish(reject, lostAnswer(new Error(`${what} stream error: ${error.message}`)));
      }
    })();
  });
}
