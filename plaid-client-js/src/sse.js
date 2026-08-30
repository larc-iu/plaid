import { transformResponse } from './transforms.js';

// A live SSE stream is never silent for long: the server sends a keepalive
// comment on service channels (every 25s) and a heartbeat event on the /listen
// bus (every 30s). So if NOTHING arrives for longer than this, the connection is
// dead: the server was killed without closing the socket, the network dropped
// it, or a reconnect caught the server mid-restart (port accepting, app not yet
// streaming). We must surface that as a drop so the registration supervisor in
// serve() can reopen it. Without the watchdog such a silent drop
// leaves `reader.read()` pending forever: readyState never reaches CLOSED, so
// nothing reconnects and the service never heals. Comfortably above both server
// cadences, so a healthy idle stream never trips it.
export const SSE_IDLE_TIMEOUT_MS = 60000;

/**
 * Project a parsed SSE `data:` object onto what a listener callback sees.
 *
 * The envelope is API surface and gets the usual `transformResponse` recasing.
 * A `message` event's `data` is NOT: it is opaque application data (whatever
 * `sendMessage` was handed), so its keys must survive verbatim, exactly as
 * `metadata` and `config` do elsewhere. Without this, a key written
 * `case-marker` reaches a JavaScript listener as `caseMarker` and a Python
 * listener as `case_marker`, so the same broadcast reads differently depending
 * on the reader's language.
 */
export function eventPayload(eventType, parsed) {
  const payload = transformResponse(parsed);
  if (eventType === 'message' && parsed && typeof parsed === 'object' && 'data' in parsed) {
    payload.data = parsed.data;
  }
  return payload;
}

/**
 * Create an SSE connection to the listen endpoint using fetch-based streaming.
 * Automatically handles heartbeat confirmations and event parsing.
 *
 * @param {Object} client - PlaidClient instance
 * @param {string} projectId - Project UUID
 * @param {function} onEvent - Callback (eventType, data). Return true to stop.
 * @param {string} [path] - Stream path under baseUrl. Defaults to the project
 *   /listen bus; service request channels pass their own. Only /listen emits
 *   `heartbeat` events needing a POST confirmation — other streams keep
 *   themselves alive with ignored SSE comments.
 * @returns {Object} SSE connection with .close(), .getStats(), .readyState
 */
export function createSSEConnection(client, projectId, onEvent, path) {
  const streamPath = path || `/api/v1/projects/${projectId}/listen`;
  const startTime = Date.now();
  let isConnected = false;
  let isClosed = false;
  let clientId = null;
  let eventStats = { 'audit-log': 0, message: 0, heartbeat: 0, connected: 0, other: 0 };
  let abortController = new AbortController();

  const sendHeartbeatConfirmation = async () => {
    if (!clientId || isClosed) return;
    try {
      const response = await fetch(`${client.baseUrl}/api/v1/projects/${projectId}/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${client.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 'client-id': clientId }),
        signal: abortController.signal,
      });
      if (!response.ok) { /* heartbeat failed */ }
    } catch (error) {
      if (error.name !== 'AbortError') { /* heartbeat error */ }
    }
  };

  // Watchdog: abort the fetch if the stream goes silent for longer than the
  // server's keepalive cadence, so a silently-dropped connection lands in the
  // catch below (readyState CLOSED) instead of blocking on a read that will
  // never resolve.
  let idleTimer = null;
  const clearIdleTimer = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (!isClosed) abortController.abort(new Error('SSE stream went silent'));
    }, SSE_IDLE_TIMEOUT_MS);
  };

  const sseConnection = {
    readyState: 0, // CONNECTING
    close: () => {
      if (!isClosed) {
        isClosed = true;
        isConnected = false;
        sseConnection.readyState = 2; // CLOSED
        clearIdleTimer();
        abortController.abort();
      }
    },
    getStats: () => ({
      durationSeconds: (Date.now() - startTime) / 1000,
      isConnected,
      isClosed,
      clientId,
      events: { ...eventStats },
      readyState: sseConnection.readyState,
    }),
  };

  // Start the streaming connection
  (async () => {
    try {
      const url = `${client.baseUrl}${streamPath}`;
      armIdleTimer();
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${client.token}`,
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        if (response.status === 409 && streamPath.includes('/services/')) {
          // Service channel rejected: another live instance holds this
          // service-id. The serve() reconnect timer will retry — once the
          // other instance is gone (or its dead channel is reaped) the retry
          // takes over.
          console.warn('Service registration rejected (409): another instance of this service is already connected; will retry');
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      isConnected = true;
      sseConnection.readyState = 1; // OPEN

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Event state persists across read chunks: an event's `event:` and
      // `data:` lines may land in separate reads, so these are reset only
      // after an event is dispatched (mirrors the Python client).
      let eventType = '';
      let data = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done || isClosed) break;
        armIdleTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          // Strip a trailing CR so CRLF-delimited streams parse cleanly.
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            data = line.slice(6);
          } else if (line === '' && eventType && data) {
            try {
              eventStats[eventType] = (eventStats[eventType] || 0) + 1;

              if (eventType === 'connected') {
                const parsedData = JSON.parse(data);
                clientId = parsedData['client-id'] || parsedData.clientId;
              } else if (eventType === 'heartbeat') {
                sendHeartbeatConfirmation();
              } else {
                const parsedData = JSON.parse(data);
                const shouldStop = onEvent(eventType, eventPayload(eventType, parsedData));
                if (shouldStop === true) {
                  sseConnection.close();
                  return;
                }
              }
            } catch (e) {
              console.warn('Failed to parse SSE event data:', e);
            }

            eventType = '';
            data = '';
          }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn('SSE connection error:', error);
      }
    } finally {
      clearIdleTimer();
      isConnected = false;
      isClosed = true;
      sseConnection.readyState = 2; // CLOSED
    }
  })();

  return sseConnection;
}
