/**
 * Convert kebab-case/namespaced key to camelCase.
 * 'layer-id' -> 'layerId'
 * 'relation/layer' -> 'layer' (namespace stripped)
 */
export function transformKeyToCamel(key) {
  return key.replace(/^[^/]+\//, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Convert camelCase key to kebab-case.
 * 'layerId' -> 'layer-id'
 */
export function transformKeyFromCamel(key) {
  return key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

/**
 * Recursively transform request object keys from camelCase to kebab-case.
 * Preserves metadata contents without transformation.
 */
export function transformRequest(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => transformRequest(item));
  if (typeof obj !== 'object') return obj;

  const transformed = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = transformKeyFromCamel(key);
    if (key === 'metadata' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      transformed[newKey] = value;
    } else {
      transformed[newKey] = transformRequest(value);
    }
  }
  return transformed;
}

/**
 * Recursively transform response object keys from kebab-case/namespaced to camelCase.
 * Preserves metadata contents without transformation.
 */
export function transformResponse(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => transformResponse(item));
  if (typeof obj !== 'object') return obj;

  const transformed = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = transformKeyToCamel(key);
    if (newKey === 'metadata' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      transformed[newKey] = value;
    } else {
      transformed[newKey] = transformResponse(value);
    }
  }
  return transformed;
}
