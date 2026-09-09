import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/shared/UserAvatar';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifyError } from '@/utils/feedback';
import { AuditEntries } from './AuditEntries';

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

export const ActivityPanel = ({ client, projectId, roster }) => {
  const [range, setRange] = useState('30');
  const [tally, setTally] = useState([]);
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const startTime = startFor(range);
    try {
      const [rows, page] = await Promise.all([
        client.audit.tally({ projectId, startTime, daily: true }),
        projectId
          ? client.projects.auditPage(projectId, { limit: 50, startTime, order: 'desc' })
          : client.audit.listPage({ limit: 50, startTime, order: 'desc' }),
      ]);
      setTally(rows || []);
      setFeed(page.entries || []);
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

  const peak = Math.max(1, ...tally.map((r) => r.changes));

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

      <section className="rounded-md border">
        <h3 className="border-b px-3 py-2 text-sm font-semibold">Who has been working</h3>
        {loading && tally.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : tally.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Nothing in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 text-right font-medium">Changes</th>
                <th className="px-3 py-2 font-medium" />
                <th className="px-3 py-2 text-right font-medium">Documents</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {tally.map((row) => (
                <tr key={row.user?.id || 'system'} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {row.user?.id ? (
                        <>
                          <UserAvatar
                            client={client}
                            userId={row.user.id}
                            displayName={row.user.displayName}
                            className="h-6 w-6"
                          />
                          <span>{row.user.displayName || row.user.id}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Before accounts were recorded</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.changes.toLocaleString()}
                  </td>
                  <td className="w-40 px-3 py-2">
                    <div className="h-1.5 w-full rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-primary"
                        style={{ width: `${(row.changes / peak) * 100}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.documents.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground" title={fullTimestamp(row.lastTs)}>
                    <div className="flex items-center gap-2">
                      <Sparkline byDay={row.byDay} />
                      <span className="whitespace-nowrap">{timeAgo(row.lastTs)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {quiet.length > 0 && (
        <section className="rounded-md border">
          <h3 className="border-b px-3 py-2 text-sm font-semibold">
            No changes in this window ({quiet.length})
          </h3>
          <p className="p-3 text-sm">{quiet.map((m) => m.displayName || m.id).join(', ')}</p>
        </section>
      )}

      <section className="rounded-md border">
        <h3 className="border-b px-3 py-2 text-sm font-semibold">Recent changes</h3>
        <AuditEntries entries={feed} showUser empty="Nothing in this window." />
      </section>
    </div>
  );
};
