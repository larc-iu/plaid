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
 * Discover the services currently connected to a project — a synchronous GET.
 * `timeout` is accepted for back-compat and ignored.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {number} [timeout] - Ignored
 * @returns {Promise<Array>} [{serviceId, serviceName, description, extras}]
 */
export function discoverServices(client, projectId, timeout) {
  return client._request('GET', `/api/v1/projects/${projectId}/services`);
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
 * @returns {Object} ServiceRegistration with .stop(), .isRunning(), .serviceInfo
 */
export function serve(client, projectId, serviceInfo, onServiceRequest, extras = {}) {
  const { serviceId, serviceName, description = '' } = serviceInfo;
  let connection = null;
  let isRunning = true;
  let reconnectTimer = null;

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

  // Reopen the channel if it drops (e.g. the server restarted). Reopening
  // re-registers the service server-side, so presence and reachability come
  // back together.
  reconnectTimer = setInterval(() => {
    if (!isRunning) return;
    if (connection && connection.readyState === 2) { // CLOSED (dropped)
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
 * @returns {Promise<any>} The service's result
 */
export function requestService(client, projectId, serviceId, data, timeout = 10000, onProgress) {
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
            body: JSON.stringify(data === undefined ? null : transformRequest(data)),
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
