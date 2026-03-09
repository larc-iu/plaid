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
 * @param {Object} client - PlaidClient instance
 * @param {function} listenFn - Bound _messagesListen function
 * @param {function} sendFn - Bound _messagesSendMessage function
 * @param {string} projectId - Project UUID
 * @param {number} timeout - Timeout in ms (default 3000)
 * @returns {Promise<Array>} Discovered services
 */
export function discoverServices(client, listenFn, sendFn, projectId, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    const discoveredServices = [];
    let connection = null;

    const timer = setTimeout(() => {
      if (connection) connection.close();
      resolve(discoveredServices);
    }, timeout);

    try {
      connection = listenFn(projectId, (eventType, eventData) => {
        if (eventType === 'message' && isServiceMessage(eventData.data)) {
          const message = eventData.data;
          if (message.type === 'service_registration' && message.requestId === requestId) {
            discoveredServices.push({
              serviceId: message.serviceId,
              serviceName: message.serviceName,
              description: message.description,
              timestamp: message.timestamp,
              extras: message.extras || {},
            });
          }
        }
      });

      const discoveryMessage = createServiceMessage('service_discovery', { requestId });
      try {
        sendFn(projectId, discoveryMessage);
      } catch (error) {
        clearTimeout(timer);
        if (connection) connection.close();
        reject(new Error(`Failed to send discovery message: ${error.message}`));
        return;
      }
    } catch (error) {
      clearTimeout(timer);
      if (connection) connection.close();
      reject(new Error(`Cannot establish SSE connection: ${error.message}`));
    }
  });
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
  const { serviceId, serviceName, description } = serviceInfo;
  let connection = null;
  let isRunning = true;

  const serviceRegistration = {
    stop: () => {
      isRunning = false;
      if (connection) connection.close();
    },
    isRunning: () => isRunning,
    serviceInfo: { serviceId, serviceName, description, extras },
  };

  try {
    connection = listenFn(projectId, (eventType, eventData) => {
      if (!isRunning) return true;

      if (eventType === 'message' && isServiceMessage(eventData.data)) {
        const message = eventData.data;

        if (message.type === 'service_discovery') {
          const registrationMessage = createServiceMessage('service_registration', {
            requestId: message.requestId,
            serviceId,
            serviceName,
            description,
            extras,
          });
          try {
            sendFn(projectId, registrationMessage);
          } catch (error) {
            console.warn('Failed to send discovery response:', error);
          }
        } else if (message.type === 'service_request' && message.serviceId === serviceId) {
          try {
            // Send acknowledgment
            const ackMessage = createServiceMessage('service_response', {
              requestId: message.requestId,
              status: 'received',
            });
            try { sendFn(projectId, ackMessage); } catch (_) { /* continue */ }

            // Create response helper
            const responseHelper = {
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
