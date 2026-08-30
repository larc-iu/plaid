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

/**
 * Discover the services seen on a project — a synchronous GET. Returns every
 * service ever registered on the project: currently connected ones carry
 * `online: true`; previously-seen offline ones carry `online: false` plus a
 * `lastSeenAt` stamp. Callers that need a service they can actually submit
 * work to should filter on `online`.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @returns {Promise<Array>} [{serviceId, serviceName, description, extras, online, lastSeenAt}]
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
  return client._request('DELETE', `/api/v1/projects/${projectId}/services/${encodeURIComponent(serviceId)}`);
}

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
 *   connection-state transitions: 'registered', 'reconnected', 'disconnected'.
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
    client
      ._request('POST', `/api/v1/projects/${projectId}/service-requests/${encodeURIComponent(requestId)}/events`, { body })
      .catch((error) => {
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

  // The channel only carries `connected` (ignored) and `service_request` events.
  const onChannelEvent = (eventType, payload) => {
    if (!isRunning) return true;
    if (eventType !== 'service_request' || !payload) return;
    const requestId = payload.requestId;
    if (!requestId) return;

    const responseHelper = {
      progress: (percent, msg) =>
        reportEvent(requestId, { status: 'progress', progress: { percent, message: msg } }),
      complete: (data) =>
        reportEvent(requestId, { status: 'completed', data }),
      error: (error) =>
        reportEvent(requestId, { status: 'error', data: { error: error?.message || error } }),
    };

    try {
      onServiceRequest(payload.data, responseHelper);
    } catch (error) {
      responseHelper.error(error?.message || error);
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
  reconnectTimer = setInterval(() => {
    if (!isRunning || !connection) return;
    if (connection.readyState === 1) { noteConnected(); return; }
    if (connection.readyState === 2) { // CLOSED (dropped or failed)
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
 * service reports an error, or on timeout.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {string} serviceId - Service ID to request
 * @param {any} data - Request payload
 * @param {number} [timeout=10000] - Timeout in ms
 * @param {function} [onProgress] - Called with each progress payload {percent, message}
 * @param {AbortSignal} [signal] - Abort to stop waiting; rejects with an AbortError
 * @returns {Promise<any>} The service's result
 */
export function requestService(client, projectId, serviceId, data, timeout = 10000, onProgress, signal) {
  // Propagate an open logical operation (client.beginOperation) to the
  // service: its writes then fold under the requester's audit-log entry
  // (the Python BaseService adopts the id around process_request). Only for a
  // plain-object payload — that's the only shape the service param schema
  // delivers anyway.
  const group = client.operationGroup;
  const payload =
    group && data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data, operationGroup: { id: group.id, message: group.message } }
      : data;
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
    const timer = setTimeout(
      () => finish(reject, new Error(`Service request timed out after ${timeout}ms`)),
      timeout,
    );

    // An external signal stops waiting on a long request (a UI's Stop button).
    // Reject with an AbortError so a caller can tell a deliberate stop from a
    // failure. The service is not told: it finishes its work and its reply
    // goes nowhere, which is safe because it has already been asked for.
    const stop = () => {
      const err = new Error('The service request was stopped');
      err.name = 'AbortError';
      finish(reject, err);
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
        response = await fetch(
          `${client.baseUrl}/api/v1/projects/${projectId}/services/${encodeURIComponent(serviceId)}/requests`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${client.token}`,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify(payload === undefined ? null : transformRequest(payload)),
            signal: abortController.signal,
          },
        );
      } catch (error) {
        if (error.name !== 'AbortError') finish(reject, new Error(`Failed to submit service request: ${error.message}`));
        return;
      }

      if (response.status === 503) {
        finish(reject, new Error(`No live service '${serviceId}' on this project`));
        return;
      }
      if (!response.ok) {
        finish(reject, new Error(`Service request failed: HTTP ${response.status} ${response.statusText}`));
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
              if (eventType === 'progress') {
                if (onProgress) { try { onProgress(payload.progress); } catch (_) { /* ignore */ } }
              } else if (eventType === 'result') {
                finish(resolve, payload.data);
                return;
              } else if (eventType === 'error') {
                finish(reject, new Error(payload?.error || 'Service request failed'));
                return;
              }
              eventType = '';
              dataLine = '';
            }
          }
        }
        finish(reject, new Error('Service closed the connection without a result'));
      } catch (error) {
        if (error.name !== 'AbortError') finish(reject, new Error(`Service request stream error: ${error.message}`));
      }
    })();
  });
}
