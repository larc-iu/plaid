/**
 * Generate a unique request ID for service coordination.
 */
export function generateRequestId() {
  return 'req_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

/**
 * Create a service coordination message.
 */
export function createServiceMessage(type, data = {}) {
  return {
    type,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

/**
 * Check if a message is a service coordination message.
 */
export function isServiceMessage(data) {
  return data && data.type && data.timestamp;
}

/**
 * Discover available services in a project.
 *
 * Reads the server-side service registry synchronously (a single GET) — no
 * broadcast handshake, no waiting. Services keep themselves listed by
 * registering + heartbeating via `serve()`.
 *
 * @param {Object} client - PlaidClient instance
 * @param {function} listenFn - Unused; kept for signature back-compat
 * @param {function} sendFn - Unused; kept for signature back-compat
 * @param {string} projectId - Project UUID
 * @param {number} timeout - Unused; kept for signature back-compat
 * @returns {Promise<Array>} Discovered services [{serviceId, serviceName, description, extras}]
 */
export function discoverServices(client, listenFn, sendFn, projectId, timeout) {
  return client.messages.listServices(projectId);
}

/**
 * Register as a service and handle incoming requests.
 *
 * @param {Object} client - PlaidClient instance
 * @param {function} listenFn - Bound _messagesListen function
 * @param {function} sendFn - Bound _messagesSendMessage function
 * @param {string} projectId - Project UUID
 * @param {Object} serviceInfo - {serviceId, serviceName, description}
 * @param {function} onServiceRequest - Handler callback
 * @param {Object} extras - Optional additional metadata
 * @returns {Object} ServiceRegistration with .stop(), .isRunning(), .serviceInfo
 */
export function serve(client, listenFn, sendFn, projectId, serviceInfo, onServiceRequest, extras = {}) {
  const { serviceId, serviceName, description = '' } = serviceInfo;
  let connection = null;
  let isRunning = true;
  let heartbeatTimer = null;

  const serviceRegistration = {
    stop: () => {
      isRunning = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Best-effort clean removal from the registry; presence would also
      // lapse on its own once the TTL elapses without a heartbeat.
      client.messages.unregisterService(projectId, serviceId).catch(() => {});
      if (connection) connection.close();
    },
    isRunning: () => isRunning,
    serviceInfo: { serviceId, serviceName, description, extras },
  };

  // Announce presence in the server-side registry, then re-register on the
  // server-advised interval to stay live. This is what makes the service
  // discoverable via a synchronous listServices() — independent of the SSE
  // channel-liveness heartbeat handled inside the connection itself.
  const registerOnce = () =>
    client.messages
      .registerService(projectId, { serviceId, serviceName, description, extras })
      .catch((error) => {
        console.warn('Failed to register service:', error.message || error);
        return null;
      });
  registerOnce().then((res) => {
    if (!isRunning) return;
    const intervalMs = (res && res.heartbeatIntervalMs) || 30000;
    heartbeatTimer = setInterval(() => {
      if (!isRunning) return;
      registerOnce();
    }, intervalMs);
  });

  try {
    connection = listenFn(projectId, (eventType, eventData) => {
      if (!isRunning) return true;

      if (eventType === 'message' && isServiceMessage(eventData.data)) {
        const message = eventData.data;

        // Discovery is served by the server-side registry (see registerOnce
        // above); this handler only fields actual work requests over the bus.
        if (message.type === 'service_request' && message.serviceId === serviceId) {
          try {
            // Send acknowledgment
            const ackMessage = createServiceMessage('service_response', {
              requestId: message.requestId,
              status: 'received',
            });
            try { sendFn(projectId, ackMessage); } catch (_) { /* continue */ }

            // Create response helper passed to the request handler for replying
            const responseHelper = {
              // Send a progress update for the in-flight request
              progress: (percent, msg) => {
                const progressMessage = createServiceMessage('service_response', {
                  requestId: message.requestId,
                  status: 'progress',
                  progress: { percent, message: msg },
                });
                try { sendFn(projectId, progressMessage); } catch (error) {
                  console.warn('Failed to send progress update:', error);
                }
              },
              // Send the final successful result for the request
              complete: (data) => {
                const completionMessage = createServiceMessage('service_response', {
                  requestId: message.requestId,
                  status: 'completed',
                  data,
                });
                try { sendFn(projectId, completionMessage); } catch (error) {
                  console.warn('Failed to send completion message:', error);
                }
              },
              // Send an error response for the request
              error: (error) => {
                const errorMessage = createServiceMessage('service_response', {
                  requestId: message.requestId,
                  status: 'error',
                  data: { error: error.message || error },
                });
                try { sendFn(projectId, errorMessage); } catch (error) {
                  console.warn('Failed to send error message:', error);
                }
              },
            };

            try {
              onServiceRequest(message.data, responseHelper);
            } catch (error) {
              responseHelper.error(error.message || error);
            }
          } catch (error) {
            const errorMessage = createServiceMessage('service_response', {
              requestId: message.requestId,
              status: 'error',
              data: { error: error.message || error },
            });
            try { sendFn(projectId, errorMessage); } catch (sendError) {
              console.warn('Failed to send error response:', sendError);
            }
          }
        }
      }
    });
  } catch (error) {
    throw new Error(`Failed to start service: ${error.message}`);
  }

  return serviceRegistration;
}

/**
 * Request a service to perform work.
 *
 * @param {Object} client - PlaidClient instance
 * @param {function} listenFn - Bound _messagesListen function
 * @param {function} sendFn - Bound _messagesSendMessage function
 * @param {string} projectId - Project UUID
 * @param {string} serviceId - Service ID to request
 * @param {any} data - Request payload
 * @param {number} timeout - Timeout in ms (default 10000)
 * @returns {Promise<any>} Service response
 */
export function requestService(client, listenFn, sendFn, projectId, serviceId, data, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    let connection = null;
    let isResolved = false;

    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        if (connection) connection.close();
        reject(new Error(`Service request timed out after ${timeout}ms`));
      }
    }, timeout);

    try {
      connection = listenFn(projectId, (eventType, eventData) => {
        if (eventType === 'message' && isServiceMessage(eventData.data)) {
          const message = eventData.data;
          if (message.type === 'service_response' && message.requestId === requestId) {
            if (message.status === 'completed') {
              if (!isResolved) {
                isResolved = true;
                clearTimeout(timer);
                connection.close();
                resolve(message.data);
              }
            } else if (message.status === 'error') {
              if (!isResolved) {
                isResolved = true;
                clearTimeout(timer);
                connection.close();
                reject(new Error(message.data?.error || 'Service request failed'));
              }
            }
          }
        }
      });

      const requestMessage = createServiceMessage('service_request', {
        requestId,
        serviceId,
        data,
      });
      try {
        sendFn(projectId, requestMessage);
      } catch (error) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timer);
          if (connection) connection.close();
          reject(new Error(`Failed to send service request: ${error.message}`));
        }
      }
    } catch (error) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        if (connection) connection.close();
        reject(new Error(`Cannot establish SSE connection: ${error.message}`));
      }
    }
  });
}
