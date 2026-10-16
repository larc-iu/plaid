// A byte count for a person: "37 bytes", "1.5 KB", "12 MB". Decimal units,
// the way the file's own operating system reports its size.
//
// With `against`, a second size shown beside it (a file and the limit it is
// over), the count takes as many decimals as it needs, up to three, to read
// differently from that one: 100.4 MB over a 100 MB limit is not "100 MB".
const UNITS = ['KB', 'MB', 'GB', 'TB'];

function shown(n, decimals) {
  if (n < 1000) return `${Math.round(n)} bytes`;
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < UNITS.length - 1) {
    value /= 1000;
    i += 1;
  }
  const d = decimals ?? (value < 10 ? 1 : 0);
  return `${d ? value.toFixed(d) : Math.round(value)} ${UNITS[i]}`;
}

export function formatBytes(n, { against } = {}) {
  if (!Number.isFinite(n) || n < 0) return '';
  const plain = shown(n);
  if (!Number.isFinite(against) || against < 0 || against === n) return plain;
  if (plain !== shown(against)) return plain;
  for (let d = 1; d < 3; d += 1) {
    if (shown(n, d) !== shown(against, d)) return shown(n, d);
  }
  return shown(n, 3);
}
