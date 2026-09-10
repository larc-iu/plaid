import { useEffect, useState } from 'react';

export const USER_SEARCH_LIMIT = 25;

// Search-to-add over the user directory (server-side ?q=), for the Access tab
// and a vocabulary's maintainers. The full roster is never fetched: it does
// not scale, and GET /users is admin-or-maintainer-gated. The search runs once
// the box is touched, an empty box browses the first page, and the ids in
// `excludeIds` (the people already on the list) are dropped. A caller who may
// not browse the directory (403) gets `denied` rather than an error.
export function useUserSearch({ client, excludeIds }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Keyed on the ids as text: a fresh array of the same people must not run
  // the search again.
  const excludeKey = excludeIds.join('\n');
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const page = await client.users.listPage({
          q: debounced || undefined,
          limit: USER_SEARCH_LIMIT,
        });
        const entries = page.entries || [];
        const known = new Set(excludeKey ? excludeKey.split('\n') : []);
        if (!cancelled) {
          setResults(entries.filter((u) => !known.has(u.id)));
          setDenied(false);
          // Measured before the known ids are dropped: that filter is why the
          // rows on screen can number fewer than the page the server sent.
          setCapped(entries.length >= USER_SEARCH_LIMIT);
        }
      } catch (err) {
        if (!cancelled) {
          setResults([]);
          setCapped(false);
          if (err?.status === 403) setDenied(true);
          else console.error('User search failed:', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, active, excludeKey, client]);

  return {
    query,
    setQuery,
    debounced,
    active,
    activate: () => setActive(true),
    results,
    loading,
    denied,
    capped,
  };
}
