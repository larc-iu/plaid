import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.jsx';
import { ListHint } from './list-search.jsx';
import { DataTable } from './data-table.jsx';
import { timeAgo, fullTimestamp } from '../../lib/formatTime.js';
import { notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { readableDescription } from '../../lib/auditText.js';
import { textIncludes } from '../../domain/collation.js';

// A paged audit feed. `fetchPage({cursor, limit})` returns the server's
// `{entries, nextCursor}` newest-first, and this holds what has been loaded so
// far: the table sorts and filters it, and "Load older" asks the server for
// the next chunk.
//
// A window's worth of history is unbounded, so it is never all pulled at once.
// A chunk is what a reader can page through without waiting, and asking for
// more is a decision they make. Sorting and searching therefore act on what is
// LOADED, the same scope for both, which is why the default order matches the
// server's and older rows have to be asked for rather than appearing.

const CHUNK = 200;

// Documents named on one row of the Where column before the rest are counted.
const WHERE_DOCS = 3;

// A unit's label, best available: the operation group's own message ("Confirm
// word analysis"), else the first operation's description, else its type.
const entryLabel = (entry) => {
  if (entry.message) return entry.message;
  const head = entry.ops?.[0];
  return readableDescription(head?.description) || head?.type || 'Change';
};

const placeOf = (entry) => entry.documents?.[0] || entry.projects?.[0] || null;

// `projectHref` and `documentHref` build the "Where" column's links. The apps
// route differently: plaid-igt opens a document at `/projects/:p/documents/:d`,
// plaid-ud at `.../annotate`, and a feed that hardcoded either would send half
// its readers to a 404. Return null from a builder to render the name as plain
// text instead of a link.
export const AuditFeed = ({
  fetchPage,
  showUser = false,
  title,
  empty = 'Nothing yet.',
  resetKey,
  id,
  scope,
  projectHref = (project) => `/projects/${project.id}`,
  documentHref = (document, project) => `/projects/${project.id}/documents/${document.id}`,
}) => {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const begin = useLatestCall();

  const load = useCallback(async () => {
    // Re-scoping starts a second read without ending the first, and the feed
    // for the scope just left can answer last.
    const isCurrent = begin();
    setLoading(true);
    try {
      const page = await fetchPage({ limit: CHUNK });
      if (!isCurrent()) return;
      setEntries(page.entries || []);
      setCursor(page.nextCursor || null);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error loading the audit feed:', err);
      notifyError(humanizeError(err), 'Could not load the recent changes');
      setEntries([]);
      setCursor(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
    // `resetKey` is what re-scopes the feed (the window, the project). The
    // fetcher is a fresh closure on every render, so it cannot be the dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, begin]);

  useEffect(() => {
    load();
  }, [load]);

  const loadOlder = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage({ limit: CHUNK, cursor });
      setEntries((prev) => [...prev, ...(page.entries || [])]);
      setCursor(page.nextCursor || null);
    } catch (err) {
      notifyError(humanizeError(err), 'Could not load the older changes');
    } finally {
      setLoadingMore(false);
    }
  };

  const columns = [
    {
      key: 'time',
      label: 'When',
      sort: (e) => (e.time ? new Date(e.time).getTime() : null),
      className: 'whitespace-nowrap text-muted-foreground',
      render: (e) => <span title={fullTimestamp(e.time)}>{timeAgo(e.time)}</span>,
    },
    ...(showUser
      ? [
          {
            key: 'user',
            label: 'Person',
            sort: (e) => (e.user?.displayName || e.user?.id || '').toLowerCase(),
            render: (e) => e.user?.displayName || e.user?.id || '—',
          },
        ]
      : []),
    {
      key: 'change',
      label: 'Change',
      sort: (e) => entryLabel(e).toLowerCase(),
      render: entryLabel,
    },
    {
      key: 'where',
      label: 'Where',
      sort: (e) => (placeOf(e)?.name || '').toLowerCase(),
      className: 'text-muted-foreground',
      render: (e) => {
        const project = e.projects?.[0];
        // EVERY document, not the first. One corpus-wide respell touched three
        // and the feed named one, so a maintainer asking what changed in the
        // other two was told nothing had. Three at most on the row, the rest
        // counted, all of them in the title.
        const documents = e.documents || [];
        if (documents.length && project) {
          const shown = documents.slice(0, WHERE_DOCS);
          const rest = documents.length - shown.length;
          return (
            <span title={rest > 0 ? documents.map((d) => d.name).join(', ') : undefined}>
              {shown.map((document, i) => {
                const href = documentHref(document, project);
                return (
                  <Fragment key={document.id}>
                    {i > 0 && ', '}
                    {href ? (
                      <Link to={href} className="hover:underline">
                        {document.name}
                      </Link>
                    ) : (
                      document.name
                    )}
                  </Fragment>
                );
              })}
              {rest > 0 && ` +${rest} more`}
            </span>
          );
        }
        if (project) {
          const href = projectHref(project);
          return href ? (
            <Link to={href} className="hover:underline">
              {project.name}
            </Link>
          ) : (
            project.name
          );
        }
        return '';
      },
    },
    {
      key: 'detail',
      label: '',
      align: 'right',
      className: 'text-xs text-muted-foreground tabular-nums',
      render: (e) => (
        <>
          {e.apiToken ? e.apiToken.name : ''}
          {e.ops?.length > 1 ? ` ${e.ops.length} writes` : ''}
        </>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <DataTable
        title={title}
        rows={entries}
        columns={columns}
        rowKey={(e) => e.id}
        id={id}
        scope={scope}
        defaultSort={{ key: 'time', dir: 'desc' }}
        search={{
          placeholder: 'Search changes…',
          match: (e, q) =>
            [
              entryLabel(e),
              e.user?.displayName,
              e.user?.id,
              ...(e.documents || []).map((d) => d.name),
              ...(e.projects || []).map((p) => p.name),
            ].some((v) => v && textIncludes(v, q)),
        }}
        noun="change"
        empty={empty}
        loading={loading}
      />
      {cursor && !loading && (
        <div className="flex items-center gap-2 px-3 pb-1">
          <Button size="sm" variant="outline" onClick={loadOlder} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </Button>
          <ListHint>Older changes are not loaded yet.</ListHint>
        </div>
      )}
    </div>
  );
};
