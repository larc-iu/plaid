const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const DIVISIONS = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
];

// Human-friendly relative time, e.g. "3 days ago". Falls back to "unknown" for
// missing/invalid input.
export function formatRelative(date) {
  if (!date) return 'unknown';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return 'unknown';

  let duration = (d.getTime() - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return 'unknown';
}
