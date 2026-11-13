import { useCallback, useEffect, useRef, useState } from 'react';
import { humanizeError, statusOf } from '@ui/lib/errors.js';

// How many rows each read asks for. An import or a job writes thousands, and
// the view shows what the first page holds before it asks for more.
export const CHANGE_ROWS_PAGE = 500;

const nothing = () => ({ rows: {}, cursors: {}, loading: true, errors: {} });

/**
 * The rows History entry `entryId` changed (`client.audit.changesPage`), read
 * a page at a time from each of `streams` (`[{key, opts}]`, `opts` narrowing
 * the read to a document or a vocabulary). The first page of each is read at
 * once, the next when `loadMore` is called. A stream the reader may not read
 * (403) holds no rows: core leaves out what a reader cannot read, row by row,
 * and a stream wholly so is the same thing. Any other failure is the
 * stream's `errors[key]`.
 *
 * Returns `{rows: {[key]: rows}, loading, more, loadMore, errors}`. A new
 * entry, or new streams, start from nothing, and a read for an entry left
 * meanwhile is dropped.
 */
export function useChangeRows(client, entryId, streams) {
  const [state, setState] = useState(nothing);
  const gen = useRef(0);
  const streamsKey = JSON.stringify(streams);
  const streamsRef = useRef(streams);
  streamsRef.current = streams;

  const readPages = useCallback(
    async (mine, which, cursors) => {
      const results = await Promise.all(
        which.map(async (s) => {
          try {
            const page = await client.audit.changesPage(entryId, {
              ...s.opts,
              limit: CHANGE_ROWS_PAGE,
              cursor: cursors[s.key] ?? undefined,
            });
            return { key: s.key, page };
          } catch (err) {
            return { key: s.key, err };
          }
        }),
      );
      if (mine !== gen.current) return;
      setState((prev) => {
        const next = {
          rows: { ...prev.rows },
          cursors: { ...prev.cursors },
          errors: { ...prev.errors },
          loading: false,
        };
        for (const { key, page, err } of results) {
          if (err) {
            next.cursors[key] = null;
            if (statusOf(err) !== 403) {
              next.errors[key] = humanizeError(err, 'Failed to read the changes.');
            }
            continue;
          }
          next.rows[key] = [...(next.rows[key] || []), ...(page?.entries || [])];
          next.cursors[key] = page?.nextCursor ?? null;
        }
        return next;
      });
    },
    [client, entryId],
  );

  useEffect(() => {
    const mine = ++gen.current;
    setState(nothing());
    if (!client || !entryId) return;
    readPages(mine, streamsRef.current, {});
  }, [client, entryId, streamsKey, readPages]);

  const loadMore = useCallback(() => {
    const which = streamsRef.current.filter((s) => state.cursors[s.key]);
    if (!which.length) return;
    setState((prev) => ({ ...prev, loading: true }));
    readPages(gen.current, which, state.cursors);
  }, [readPages, state.cursors]);

  return {
    rows: state.rows,
    loading: state.loading,
    more: Object.values(state.cursors).some(Boolean),
    loadMore,
    errors: state.errors,
  };
}
