import { useEffect, useState } from 'react';
import { humanizeError, statusOf } from '@ui/lib/errors.js';

// How many rows each read asks for: core's largest page.
export const CHANGE_ROWS_PAGE = 1000;

// The most rows a stream is read to. The rows of one entry depend on each
// other (a text edit's shifted tokens and its text, an import's text, tokens
// and spans), so nothing is drawn from part of them, and an entry is read
// whole before it is drawn. Measured on a copy of prod (fixes/UC.md), the
// largest job's group wrote 14,746 rows across all its documents, read whole
// in 1.8 to 5.4 s, an import 5,788 to 8,925, an assistant plan at most
// 7,977: every entry measured fits, and one past this is a document deleted
// or a huge import, which the view does not draw.
export const CHANGE_ROWS_CEILING = 20000;

const start = () => ({ rows: {}, over: {}, errors: {}, reading: true, read: 0 });

/**
 * Every row History entry `entryId` changed (`client.audit.changesPage`), in
 * each of `streams` (`[{key, opts}]`, `opts` narrowing the read to a document
 * or a vocabulary), read page after page to the end before anything is
 * handed over. `read` counts the rows read so far, for the wait.
 *
 * A stream with a row beyond CHANGE_ROWS_CEILING is not read further:
 * `over[key]`, and no rows for it. A stream the reader may not read (403 on
 * its first page) holds no rows: core leaves out what a reader cannot read,
 * row by row, and a stream wholly so is the same thing. Any other failure, a
 * 403 after the first page too, is the stream's `errors[key]`, and no rows
 * for it.
 *
 * Returns `{rows: {[key]: rows}, over, errors, reading, read}`. A new entry,
 * or new streams, start from nothing, and a read for an entry left meanwhile
 * is dropped.
 */
export function useChangeRows(client, entryId, streams) {
  const [state, setState] = useState(start);
  const streamsKey = JSON.stringify(streams);

  useEffect(() => {
    setState(start());
    if (!client || !entryId) return undefined;
    let live = true;
    const read = async () => {
      const rows = {};
      const over = {};
      const errors = {};
      let count = 0;
      for (const s of JSON.parse(streamsKey)) {
        let mine = [];
        let cursor;
        do {
          let page;
          try {
            page = await client.audit.changesPage(entryId, {
              ...s.opts,
              limit: CHANGE_ROWS_PAGE,
              cursor,
            });
          } catch (err) {
            if (!live) return;
            // A stream refused from its first page holds nothing this reader
            // may read. Refused or failed after rows were read, it is a
            // failure: what was read is part of the rows.
            if (statusOf(err) !== 403 || cursor) {
              errors[s.key] = humanizeError(err, 'Failed to read the changes.');
            }
            mine = [];
            break;
          }
          if (!live) return;
          const entries = page?.entries || [];
          for (const r of entries) mine.push(r);
          count += entries.length;
          cursor = page?.nextCursor ?? null;
          // Past the ceiling only on a row beyond it: core gives a cursor
          // after any full page, a last one too.
          if (mine.length > CHANGE_ROWS_CEILING) {
            over[s.key] = true;
            mine = [];
            break;
          }
          setState((prev) => ({ ...prev, read: count }));
        } while (cursor);
        rows[s.key] = mine;
      }
      if (live) setState({ rows, over, errors, reading: false, read: count });
    };
    read();
    return () => {
      live = false;
    };
  }, [client, entryId, streamsKey]);

  return state;
}
