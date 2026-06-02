import { transformResponse } from './transforms.js';

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

  const sseConnection = {
    readyState: 0, // CONNECTING
    close: () => {
      if (!isClosed) {
        isClosed = true;
        isConnected = false;
        sseConnection.readyState = 2; // CLOSED
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
                const shouldStop = onEvent(eventType, transformResponse(parsedData));
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
      isConnected = false;
      isClosed = true;
      sseConnection.readyState = 2; // CLOSED
    }
  })();

  return sseConnection;
}
