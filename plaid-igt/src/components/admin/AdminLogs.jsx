import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { Switch } from '@ui/components/ui/switch';
import { DataTable } from '@ui/components/shared/data-table';
import { SearchInput } from '@ui/components/shared/list-search';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { fullTimestamp } from '@ui/lib/formatTime.js';
import { notifyError, humanizeError } from '@/utils/feedback';

// What the server is doing right now, and what went wrong. Requests and
// events are buffered apart on the server, so a bulk import cannot push the
// one error off the screen, and they are shown apart here for the same
// reason.
//
// Search, level and status are applied on the SERVER, over the whole buffer.
// Sorting and paging are this screen's, over what came back. That is why the
// tables carry no search box of their own: a second search that reached only
// the last 300 entries would quietly disagree with the first.

const LIMIT = 300;
const LIVE_MS = 5000;

const clockTime = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

// A status wears the colour of the level its line was logged at, so the two
// tables agree: amber for what was a warning, red for what was an error.
const WARN_BADGE = 'border-amber-500 text-amber-700';

const StatusBadge = ({ entry }) => {
  if (entry.error) {
    return (
      <Badge variant="destructive" title={entry.error}>
        threw
      </Badge>
    );
  }
  if (entry.status >= 500) return <Badge variant="destructive">{entry.status}</Badge>;
  if (entry.status >= 400)
    return (
      <Badge variant="outline" className={WARN_BADGE}>
        {entry.status}
      </Badge>
    );
  if (entry.status) return <span className="text-muted-foreground">{entry.status}</span>;
  return <span className="text-muted-foreground">no response</span>;
};

const LEVEL_STYLE = {
  error: 'destructive',
  fatal: 'destructive',
  report: 'default',
};

const LevelBadge = ({ level }) => {
  const variant = LEVEL_STYLE[level];
  if (variant) return <Badge variant={variant}>{level}</Badge>;
  if (level === 'warn')
    return (
      <Badge variant="outline" className={WARN_BADGE}>
        warn
      </Badge>
    );
  return <span className="text-muted-foreground">{level}</span>;
};

// One labelled number. Nothing is drawn for a value the server had nothing to
// compute from, such as a percentile over an empty window.
const Stat = ({ label, value, tone }) =>
  value === null || value === undefined ? null : (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${tone || ''}`}>{value}</div>
    </div>
  );

const number = (n) => (typeof n === 'number' ? n.toLocaleString() : n);
const millis = (n) => (typeof n === 'number' ? `${number(n)}ms` : null);

// A stable key per row. Two requests can share a millisecond, a path and a
// duration, so the position in the buffer (which arrives newest first and is
// replaced whole on every refresh) is what tells them apart.
const keyed = (entries) => (entries || []).map((e, i) => ({ ...e, key: `${e.ts}:${i}` }));

export const AdminLogs = ({ client }) => {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [level, setLevel] = useState('all');
  const [user, setUser] = useState('');

  const [fileOpen, setFileOpen] = useState(false);
  const [file, setFile] = useState(null);
  // How many reads are open, and the ticket the newest one took. A read whose
  // ticket is no longer the newest is a filter the reader has already moved
  // off, so its rows are dropped rather than drawn over the ones they asked
  // for.
  const inFlight = useRef(0);
  const generation = useRef(0);

  // The search box types faster than the server should be asked.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async ({ quiet } = {}) => {
      // The live poll steps aside for a read already going. A filter change
      // never does: the newest filter has to be the one that asks.
      if (quiet && inFlight.current) return;
      const ticket = (generation.current += 1);
      inFlight.current += 1;
      if (!quiet) setLoading(true);
      try {
        const next = await client.admin.logs({
          limit: LIMIT,
          q: search || undefined,
          status: status === 'all' ? undefined : status,
          level: level === 'all' ? undefined : level,
          user: user || undefined,
        });
        if (ticket !== generation.current) return;
        setLog({
          ...next,
          requests: { ...next.requests, entries: keyed(next.requests?.entries) },
          events: { ...next.events, entries: keyed(next.events?.entries) },
        });
      } catch (err) {
        if (ticket !== generation.current) return;
        if (!quiet) notifyError(humanizeError(err), 'Could not read the log');
      } finally {
        inFlight.current -= 1;
        if (ticket === generation.current) setLoading(false);
      }
    },
    [client, search, status, level, user],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => load({ quiet: true }), LIVE_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const loadFile = useCallback(async () => {
    try {
      setFile(await client.admin.logFile({ lines: 500 }));
    } catch (err) {
      notifyError(humanizeError(err), 'Could not read the log file');
    }
  }, [client]);

  const openFile = () => {
    const next = !fileOpen;
    setFileOpen(next);
    if (next && !file) loadFile();
  };

  const requests = log?.requests;
  const events = log?.events;
  const stats = requests?.stats;

  const requestColumns = [
    {
      key: 'ts',
      label: 'Time',
      sort: (r) => r.ts,
      className: 'whitespace-nowrap font-mono text-xs',
      render: (r) => <span title={fullTimestamp(r.ts)}>{clockTime(r.ts)}</span>,
    },
    {
      key: 'method',
      label: 'Method',
      sort: (r) => r.method,
      className: 'font-mono text-xs',
      render: (r) => r.method,
    },
    {
      key: 'path',
      label: 'Path',
      sort: (r) => r.path,
      className: 'max-w-[26rem] truncate font-mono text-xs',
      render: (r) => (
        <span title={r.query ? `${r.path}?${r.query}` : r.path}>
          {r.path}
          {r.query && <span className="text-muted-foreground">?{r.query}</span>}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sort: (r) => (r.error ? 599 : r.status),
      headerClassName: 'w-20',
      render: (r) => <StatusBadge entry={r} />,
    },
    {
      key: 'ms',
      label: 'Time taken',
      sort: (r) => r.ms,
      align: 'right',
      headerClassName: 'w-24',
      className: 'whitespace-nowrap font-mono text-xs',
      render: (r) => `${number(r.ms)}ms`,
    },
    {
      key: 'user',
      label: 'Account',
      sort: (r) => r.user,
      className: 'max-w-[14rem] truncate',
      render: (r) =>
        r.user ? (
          <button
            type="button"
            className="text-xs underline decoration-dotted underline-offset-2 hover:text-primary"
            title={`Show only ${r.user}`}
            onClick={() => setUser(r.user)}
          >
            {r.user}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">anonymous</span>
        ),
    },
  ];

  const eventColumns = [
    {
      key: 'ts',
      label: 'Time',
      sort: (e) => e.ts,
      className: 'whitespace-nowrap font-mono text-xs',
      render: (e) => <span title={fullTimestamp(e.ts)}>{clockTime(e.ts)}</span>,
    },
    {
      key: 'level',
      label: 'Level',
      sort: (e) => e.level,
      headerClassName: 'w-24',
      render: (e) => <LevelBadge level={e.level} />,
    },
    {
      key: 'ns',
      label: 'Source',
      sort: (e) => e.ns,
      className: 'max-w-[16rem] truncate font-mono text-xs',
      render: (e) => <span title={e.ns}>{e.ns}</span>,
    },
    {
      key: 'message',
      label: 'Message',
      className: 'max-w-[34rem] truncate',
      render: (e) => <span title={e.message}>{e.message}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search the log…"
          className="w-64"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="failures">Failures</SelectItem>
            <SelectItem value="2xx">2xx</SelectItem>
            <SelectItem value="4xx">4xx</SelectItem>
            <SelectItem value="5xx">5xx</SelectItem>
          </SelectContent>
        </Select>
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any level</SelectItem>
            <SelectItem value="warn">Warnings and errors</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
          </SelectContent>
        </Select>
        {user && (
          <Badge variant="secondary" className="gap-1">
            {user}
            <button type="button" aria-label="Clear account filter" onClick={() => setUser('')}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm">
            <Switch checked={live} onCheckedChange={setLive} aria-label="Live" />
            Live
          </label>
          <Button size="sm" variant="outline" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Stat
          label="Requests"
          value={
            requests
              ? `${number(requests.matched)}${requests.matched < requests.held ? ` of ${number(requests.held)}` : ''}`
              : null
          }
        />
        <Stat label="Per minute" value={stats?.perMinute} />
        <Stat
          label="Failures"
          value={stats ? stats.failures : null}
          tone={stats?.failures > 0 ? 'text-destructive' : ''}
        />
        <Stat label="Median" value={millis(stats?.p50)} />
        <Stat label="95th percentile" value={millis(stats?.p95)} />
        <Stat label="Slowest" value={millis(stats?.max)} />
        <Stat
          label="Errors"
          value={events ? (events.byLevel?.error ?? 0) : null}
          tone={events?.byLevel?.error > 0 ? 'text-destructive' : ''}
        />
        <Stat label="Warnings" value={events ? (events.byLevel?.warn ?? 0) : null} />
      </div>

      <DataTable
        title="Events"
        rows={events?.entries || []}
        columns={eventColumns}
        rowKey={(e) => e.key}
        id="admin-log-events"
        defaultSort={{ key: 'ts', dir: 'desc' }}
        pageParam="events"
        noun="event"
        empty="Nothing logged outside the requests below."
        loading={loading}
        expand={(e) => (
          <div className="flex flex-col gap-2">
            <p className="whitespace-pre-wrap text-xs">{e.message}</p>
            {e.trace && (
              <pre className="max-h-64 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed">
                {e.trace}
              </pre>
            )}
          </div>
        )}
      />

      <DataTable
        title="Requests"
        rows={requests?.entries || []}
        columns={requestColumns}
        rowKey={(r) => r.key}
        id="admin-log-requests"
        defaultSort={{ key: 'ts', dir: 'desc' }}
        pageParam="requests"
        noun="request"
        empty="No request in the buffer matches."
        loading={loading}
        expand={(r) => (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Path</dt>
            <dd className="break-all font-mono">
              {r.path}
              {r.query ? `?${r.query}` : ''}
            </dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="font-mono">{r.user || 'anonymous'}</dd>
            <dt className="text-muted-foreground">Address</dt>
            <dd className="font-mono">{r.ip || 'unknown'}</dd>
            {r.token && (
              <>
                <dt className="text-muted-foreground">API token</dt>
                <dd className="font-mono">{r.token}</dd>
              </>
            )}
            {r.error && (
              <>
                <dt className="text-muted-foreground">Exception</dt>
                <dd className="font-mono text-destructive">{r.error}</dd>
              </>
            )}
          </dl>
        )}
      />

      {log?.file && (
        <section className="rounded-md border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-expanded={fileOpen}
              aria-label={fileOpen ? 'Close' : 'Open'}
              onClick={openFile}
            >
              {fileOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
            <h3 className="text-sm font-semibold">Log file</h3>
            <span className="truncate font-mono text-xs text-muted-foreground">{log.file}</span>
            {fileOpen && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={loadFile}>
                Refresh
              </Button>
            )}
          </div>
          {fileOpen && (
            <div className="p-3">
              {file?.error ? (
                <p className="text-sm text-muted-foreground">{file.error}</p>
              ) : (
                <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs leading-relaxed">
                  {(file?.lines || []).join('\n')}
                </pre>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
