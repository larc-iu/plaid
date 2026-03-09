import { transformRequest, transformResponse } from './transforms.js';

/**
 * Extract and update document versions from response headers and body.
 */
export function extractDocumentVersions(client, responseHeaders, responseBody = null) {
  const docVersionsHeader = responseHeaders.get('X-Document-Versions');
  if (docVersionsHeader) {
    try {
      const versionsMap = JSON.parse(docVersionsHeader);
      if (typeof versionsMap === 'object' && versionsMap !== null) {
        Object.entries(versionsMap).forEach(([docId, version]) => {
          client.documentVersions = { ...client.documentVersions };
          client.documentVersions[docId] = version;
        });
      }
    } catch (e) {
      console.warn('Failed to parse document versions header:', e);
    }
  }

  if (responseBody && typeof responseBody === 'object') {
    if (responseBody['document/id'] && responseBody['document/version']) {
      client.documentVersions = { ...client.documentVersions };
      client.documentVersions[responseBody['document/id']] = responseBody['document/version'];
    }
  }
}

/**
 * Create an enriched error from a failed HTTP response.
 */
function makeHttpError(response, errorData, url, method) {
  const serverMessage = errorData?.error || errorData?.message || response.statusText;
  const error = new Error(`HTTP ${response.status} ${serverMessage} at ${url}`);
  error.status = response.status;
  error.statusText = response.statusText;
  error.url = url;
  error.method = method;
  error.responseData = errorData;
  return error;
}

/**
 * Create a network error.
 */
function makeNetworkError(originalError, url, method) {
  const error = new Error(`Network error: ${originalError.message} at ${url}`);
  error.status = 0;
  error.url = url;
  error.method = method;
  error.originalError = originalError;
  return error;
}

/**
 * Generic request method handling all fetch logic.
 *
 * Options:
 *   body            - Object body, run through transformRequest
 *   rawBody         - Body value passed directly (no transform). Mutually exclusive with body.
 *   formData        - If true, body is FormData; skip Content-Type header
 *   queryParams     - Object of query param key/values to append
 *   noBatch         - If true, throw when in batch mode
 *   skipResponseTransform - Return raw parsed JSON (no transformResponse)
 *   noAuth          - Skip Authorization header
 *   binaryResponse  - Return arrayBuffer instead of JSON/text
 */
export async function makeRequest(client, method, path, options = {}) {
  const {
    body,
    rawBody,
    formData,
    queryParams,
    noBatch,
    skipResponseTransform,
    noAuth,
    binaryResponse,
  } = options;

  // Build URL
  let url = `${client.baseUrl}${path}`;

  // Append query params
  if (queryParams) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        params.append(key, value);
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  // Prepare request body
  let requestBody;
  if (formData) {
    requestBody = body; // FormData passed directly
  } else if (rawBody !== undefined) {
    requestBody = rawBody;
  } else if (body !== undefined) {
    requestBody = transformRequest(body);
  }

  // Strict mode: append document-version for non-GET requests
  if (client.strictModeDocumentId && method !== 'GET') {
    const docId = client.strictModeDocumentId;
    if (client.documentVersions[docId]) {
      const docVersion = client.documentVersions[docId];
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
    }
  }

  // Batch mode
  if (client.isBatching) {
    if (noBatch) {
      throw new Error(`This endpoint cannot be used in batch mode: ${path}`);
    }
    const operation = {
      path: url.replace(client.baseUrl, ''),
      method: method.toUpperCase(),
    };
    if (requestBody !== undefined) {
      operation.body = requestBody;
    }
    client.batchOperations.push(operation);
    return { batched: true };
  }

  // Build fetch options
  const headers = {};
  if (!noAuth) {
    headers['Authorization'] = `Bearer ${client.token}`;
  }
  if (!formData) {
    headers['Content-Type'] = 'application/json';
  }
  if (client.agentName) {
    headers['X-Agent-Name'] = client.agentName;
  }

  const fetchOptions = { method, headers };
  if (requestBody !== undefined) {
    fetchOptions.body = formData ? requestBody : JSON.stringify(requestBody);
  }

  try {
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (_) {
        errorData = { message: await response.text().catch(() => 'Unable to read error response') };
      }
      throw makeHttpError(response, errorData, url, method);
    }

    // Binary response (getMedia)
    if (binaryResponse) {
      extractDocumentVersions(client, response.headers);
      return await response.arrayBuffer();
    }

    // JSON or text response
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      extractDocumentVersions(client, response.headers, data);
      if (skipResponseTransform) {
        return data;
      }
      return transformResponse(data);
    } else {
      extractDocumentVersions(client, response.headers);
      return await response.text();
    }
  } catch (error) {
    if (error.status !== undefined) {
      throw error;
    }
    throw makeNetworkError(error, url, method);
  }
}
