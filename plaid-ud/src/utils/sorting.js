// Sorting helpers for the list views. Pure functions; no React.

// Toggle helper for a { key, dir } sort state: clicking the same key flips
// direction, a new key starts ascending.
export const nextSort = (key) => (s) =>
  s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };

// Null/undefined sort last; strings compare case-insensitively, everything else
// with < / >.
export const cmp = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return a < b ? -1 : a > b ? 1 : 0;
};

// Sort a copy of `items` by `extract(item) -> comparable`, honoring direction.
// Nulls are forced last in BOTH directions (so "no value" never tops the list).
export const sortBy = (items, extract, dir) => {
  const sign = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = extract(a), bv = extract(b);
    if (av == null || bv == null) return cmp(av, bv); // nulls last, ignore sign
    return sign * cmp(av, bv);
  });
};
