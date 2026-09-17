/** JSON with object keys sorted, so equal values stringify equally. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(',')}}`;
}
