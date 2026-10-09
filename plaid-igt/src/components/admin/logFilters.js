// The Admin > Logs filters, kept in the URL beside `?tab=logs` so a filtered
// view can be reloaded, opened in a new tab or sent to another admin, and the
// account in a request row is a real link to its filtered view. The search
// box writes what was typed once it settles, replacing the entry rather than
// pushing one per keystroke. A value the screen does not offer is dropped
// from the address. The tables' pages (`?events=`, `?requests=`) belong to
// the tab too, and go back to the first page whenever a filter changes.
const STATUSES = ['failures', '2xx', '4xx', '5xx'];
const LEVELS = ['warn', 'error'];
const PAGE_PARAMS = ['events', 'requests'];
const FILTER_PARAMS = ['q', 'status', 'level', 'account'];
// Everything this tab keeps in the URL, for the tab group to drop on a move.
export const LOG_PARAMS = [...FILTER_PARAMS, ...PAGE_PARAMS];

export const readFilters = (params) => {
  const status = params.get('status');
  const level = params.get('level');
  return {
    search: (params.get('q') || '').trim(),
    status: STATUSES.includes(status) ? status : 'all',
    level: LEVELS.includes(level) ? level : 'all',
    account: (params.get('account') || '').trim(),
  };
};

// The params with `changes` applied. An empty value or `all` is the bare
// address, and the pages start over.
export const withFilters = (params, changes) => {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
  }
  for (const key of PAGE_PARAMS) next.delete(key);
  return next;
};

// The params as they would be with the malformed filters dropped, or null
// when every filter in them is one the screen shows.
export const withoutMalformed = (params) => {
  const { search, status, level, account } = readFilters(params);
  const shown = { q: search, status, level, account };
  // A filter at its default (empty, or `all`) is the bare address too.
  const bare = (key) => !shown[key] || shown[key] === 'all';
  const stale = FILTER_PARAMS.filter(
    (key) => params.get(key) !== null && (bare(key) || params.get(key) !== shown[key]),
  );
  if (stale.length === 0) return null;
  const next = new URLSearchParams(params);
  for (const key of stale) {
    if (bare(key)) next.delete(key);
    else next.set(key, shown[key]);
  }
  return next;
};
