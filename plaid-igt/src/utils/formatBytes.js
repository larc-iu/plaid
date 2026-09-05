// A byte count for a person: "37 bytes", "1.5 KB", "12 MB". Decimal units,
// the way the file's own operating system reports its size.
const UNITS = ['KB', 'MB', 'GB', 'TB'];

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} bytes`;
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < UNITS.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[i]}`;
}
