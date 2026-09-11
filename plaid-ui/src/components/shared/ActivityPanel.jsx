import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button.jsx';
import { DataTable } from '../ui/data-table.jsx';
import { UserAvatar } from './UserAvatar.jsx';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { notifyError } from '../../lib/notify.js';
import { AuditFeed } from './AuditFeed.jsx';

// Who has been working, and on what. Two reads: a tally of people, and the
// feed of what happened. `projectId` scopes both to one project, which is what
// the project's own Activity tab passes; without it this is the whole server.
//
// The tally only knows about people who did something, so `roster` (the
// project's members, or the account directory) supplies the other half: who
// was expected and has not appeared.

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

const startFor = (range) =>
  range === 'all' ? undefined : new Date(Date.now() - Number(range) * 86400000).toISOString();

// The last fortnight of daily counts as bars, so steady work reads differently
// from one burst. Scaled to the busiest day shown. `byDay` is a list of
// {date, changes}, not a map: a date used as a key does not survive the
// client's key casing.
const Sparkline = ({ byDay, days = 14 }) => {
  const counts = new Map((byDay || []).map((d) => [d.date, d.changes]));
  const today = new Date();
  const cells = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    cells.push([date, counts.get(date) || 0]);
  }
  const peak = Math.max(1, ...cells.map(([, n]) => n));
  return (
    <div className="flex h-6 items-end gap-px" aria-hidden="true">
      {cells.map(([date, n]) => (
        <div
          key={date}
          title={`${date}: ${n}`}
          className="w-1.5 rounded-sm bg-primary/70"
          style={{ height: `${n === 0 ? 4 : Math.max(12, (n / peak) * 100)}%` }}
        />
      ))}
    </div>
  );
};

// `showAvatars` is off for an app that has decided against them (plaid-ud has,
// deliberately), and the two href builders are AuditFeed's, passed straight
// through so a mounting app names its own routes once.
export const ActivityPanel = ({
  client,
  projectId,
  roster,
  showAvatars = true,
  projectHref,
  documentHref,
}) => {
  const [range, setRange] = useState('30');
  const [tally, setTally] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTally(
        (await client.audit.tally({ projectId, startTime: startFor(range), daily: true })) || [],
      );
    } catch (err) {
      console.error('Error loading activity:', err);
      notifyError(err.message || 'Failed to load activity', 'Error');
    } finally {
      setLoading(false);
    }
  }, [client, projectId, range]);

  useEffect(() => {
    load();
  }, [load]);

  const byUser = useMemo(() => {
    const map = new Map();
    tally.forEach((row) => {
      if (row.user?.id) map.set(row.user.id, row);
    });
    return map;
  }, [tally]);

  const quiet = useMemo(() => (roster || []).filter((m) => !byUser.has(m.id)), [roster, byUser]);

  const nameOf = (row) => row.user?.displayName || row.user?.id || '';

  // The busiest person in the window, so the share bars are comparable down
  // the column rather than each filling its own cell.
  const peak = Math.max(1, ...tally.map((r) => r.changes));

  const tallyColumns = [
    {
      key: 'person',
      label: 'Person',
      sort: (row) => nameOf(row).toLowerCase(),
      render: (row) =>
        row.user?.id ? (
          <div className="flex items-center gap-2">
            {showAvatars && (
              <UserAvatar
                client={client}
                userId={row.user.id}
                displayName={row.user.displayName}
                className="h-6 w-6"
              />
            )}
            <span>{nameOf(row)}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">Before accounts were recorded</span>
        ),
    },
    {
      key: 'changes',
      label: 'Changes',
      sort: (row) => row.changes,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => row.changes.toLocaleString(),
    },
    {
      key: 'share',
      label: '',
      headerClassName: 'w-40',
      render: (row) => (
        <div className="h-1.5 w-full rounded-full bg-muted">
          <div
            className="h-1.5 rounded-full bg-primary"
            style={{ width: `${(row.changes / peak) * 100}%` }}
          />
        </div>
      ),
    },
    {
      key: 'documents',
      label: 'Documents',
      sort: (row) => row.documents,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => row.documents.toLocaleString(),
    },
    {
      key: 'lastSeen',
      label: 'Last seen',
      sort: (row) => (row.lastTs ? new Date(row.lastTs).getTime() : null),
      className: 'text-muted-foreground',
      render: (row) => (
        <div className="flex items-center gap-2" title={fullTimestamp(row.lastTs)}>
          <Sparkline byDay={row.byDay} />
          <span className="whitespace-nowrap">{timeAgo(row.lastTs)}</span>
        </div>
      ),
    },
  ];

  const quietColumns = [
    {
      key: 'person',
      label: 'Person',
      sort: (m) => (m.displayName || m.id).toLowerCase(),
      render: (m) => (
        <div className="flex items-center gap-2">
          {showAvatars && (
            <UserAvatar
              client={client}
              userId={m.id}
              displayName={m.displayName}
              className="h-6 w-6"
            />
          )}
          <span>{m.displayName || m.id}</span>
        </div>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      sort: (m) => m.id.toLowerCase(),
      align: 'right',
      className: 'text-muted-foreground',
      render: (m) => m.id,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1">
        {WINDOWS.map((w) => (
          <Button
            key={w.value}
            size="sm"
            variant={range === w.value ? 'secondary' : 'ghost'}
            onClick={() => setRange(w.value)}
          >
            {w.label}
          </Button>
        ))}
      </div>

      <DataTable
        title="Who has been working"
        rows={tally}
        columns={tallyColumns}
        rowKey={(row) => row.user?.id || 'system'}
        id="activity-tally"
        scope={projectId}
        defaultSort={{ key: 'changes', dir: 'desc' }}
        search={{
          placeholder: 'Search people…',
          match: (row, q) => nameOf(row).toLowerCase().includes(q),
        }}
        noun="person"
        empty="Nothing in this window."
        loading={loading}
      />

      {quiet.length > 0 && (
        <DataTable
          title="No changes in this window"
          rows={quiet}
          columns={quietColumns}
          rowKey={(m) => m.id}
          id="activity-quiet"
          scope={projectId}
          defaultSort={{ key: 'person', dir: 'asc' }}
          search={{
            placeholder: 'Search people…',
            match: (m, q) => (m.displayName || m.id).toLowerCase().includes(q),
          }}
          noun="person"
        />
      )}

      <AuditFeed
        title="Recent changes"
        id="activity-feed"
        scope={projectId}
        projectHref={projectHref}
        documentHref={documentHref}
        resetKey={`${projectId || 'all'}:${range}`}
        showUser
        empty="Nothing in this window."
        fetchPage={({ limit, cursor }) => {
          const opts = { limit, cursor, order: 'desc', startTime: startFor(range) };
          return projectId
            ? client.projects.auditPage(projectId, opts)
            : client.audit.listPage(opts);
        }}
      />
    </div>
  );
};
