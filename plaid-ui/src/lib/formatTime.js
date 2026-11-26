// Small time formatters. Ported from plaid-ud.
import { language } from './i18n.js';

const DIVISIONS = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

// The locale the formatters follow: the interface's language, or in English
// the browser's own conventions, as before there was a choice of language.
const locale = () => {
  const lng = language();
  return lng === 'en' ? undefined : lng;
};

// One formatter per locale, made when first asked for: the language is not
// known when this module loads.
const formatters = new Map();
const rtf = () => {
  const lng = locale();
  let f = formatters.get(lng);
  if (!f) {
    f = new Intl.RelativeTimeFormat(lng, { numeric: 'auto' });
    formatters.set(lng, f);
  }
  return f;
};

// Compact relative time, e.g. "3 hours ago" / "yesterday". '' for falsy/invalid.
// The one relative time in the app: every list column, the assistant's
// conversations, the comment threads, and the token list read the same way.
export const timeAgo = (iso, now = Date.now()) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  let duration = (then - now) / 1000; // seconds; negative = past
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf().format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return '';
};

// Full localized timestamp, for tooltips. '' for falsy/invalid.
export const fullTimestamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale());
};
