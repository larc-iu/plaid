import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ListPager } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { formatBytes } from '@/utils/formatBytes';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@/components/shared/ConfirmProvider';

// What the server is doing and what it is sitting on. Read-only except for
// three buttons, each of which only ever unblocks something.

const Section = ({ title, action, children }) => (
  <section className="rounded-md border">
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {action}
    </div>
    <div className="p-3">{children}</div>
  </section>
);

const Facts = ({ rows }) => (
  <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
    {rows
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-mono text-xs leading-5">{value}</dd>
        </div>
      ))}
  </dl>
);

const duration = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

export const AdminServer = ({ client }) => {
  const confirm = useConfirm();
  const [report, setReport] = useState(null);
  const [locks, setLocks] = useState([]);
  const [rateLimits, setRateLimits] = useState(null);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [srv, lk, rl, lg] = await Promise.all([
        client.admin.server(),
        client.admin.locks(),
        client.admin.rateLimits(),
        client.admin.logs({ lines: 200 }),
      ]);
      setReport(srv);
      setLocks(lk.entries || []);
      setRateLimits(rl);
      setLogs(lg);
    } catch (err) {
      console.error('Error loading server report:', err);
      notifyError(err.message || 'Failed to load the server report', 'Error');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const runBackup = async () => {
    setBackingUp(true);
    try {
      const result = await client.admin.backup();
      if (result.ok) {
        notifySuccess(result.backups?.[0]?.name || 'Backup written', 'Backup complete');
        setReport((r) => (r ? { ...r, backup: result } : r));
      } else {
        notifyError('The server could not write the backup. Check the log.', 'Backup failed');
      }
    } catch (err) {
      notifyError(err.message || 'Failed to take a backup', 'Backup failed');
    } finally {
      setBackingUp(false);
    }
  };

  const breakLock = async (lock) => {
    const ok = await confirm({
      title: 'Release this lock?',
      description: `Held by ${lock.userId}. Releasing lets anyone write to the document again.`,
      confirmLabel: 'Release',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.admin.releaseLock(lock.documentId);
      setLocks((ls) => ls.filter((l) => l.documentId !== lock.documentId));
      notifySuccess('Lock released', 'Released');
    } catch (err) {
      notifyError(err.message || 'Failed to release the lock', 'Error');
    }
  };

  const clearBucket = async (ip, userId) => {
    try {
      await client.admin.clearRateLimits({ ip, userId });
      setRateLimits(await client.admin.rateLimits());
      notifySuccess(userId ? `${userId} at ${ip} cleared` : `${ip} cleared`, 'Cleared');
    } catch (err) {
      notifyError(err.message || 'Failed to clear', 'Error');
    }
  };

  const buckets = useMemo(
    () => [
      ...(rateLimits?.logins || []).map((b) => ({ ...b, kind: 'Login' })),
      ...(rateLimits?.ips || []).map((b) => ({ ...b, kind: 'Address' })),
      ...(rateLimits?.invites || []).map((b) => ({ ...b, kind: 'Invite' })),
    ],
    [rateLimits],
  );
  // Both of these are small in ordinary use and unbounded in principle: a
  // class all editing at once, a spray across many addresses.
  const pagedLocks = usePagedList(locks);
  const pagedBuckets = usePagedList(buckets);

  if (loading && !report) return <p className="py-8 text-sm text-muted-foreground">Loading…</p>;
  if (!report) return null;

  const { jvm, database, media, backup, settings } = report;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Server">
          <Facts
            rows={[
              ['Version', report.version],
              ['Uptime', `${duration(jvm.uptimeMs)} (since ${fullTimestamp(jvm.startedAt)})`],
              ['Java', jvm.java],
              ['Heap', `${formatBytes(jvm.heapUsed)} of ${formatBytes(jvm.heapMax)}`],
              ['Port', settings.port],
              ['Log level', settings.logLevel],
              ['Session lifetime', `${Math.round((settings.jwtTtlSeconds || 0) / 86400)} days`],
              ['Editing lock', `${Math.round((settings.lockExpirationMs || 0) / 1000)}s`],
              ['OpenAPI', settings.openapiExposed ? 'Exposed' : 'Hidden'],
              [
                'Upload limit',
                `${settings.mediaMaxFileMb} MB media, ${settings.maxJsonBodyMb} MB JSON`,
              ],
              ['CORS origins', (settings.corsAllowedOrigins || []).join(', ') || 'None'],
            ]}
          />
        </Section>

        <Section title="Database">
          <Facts
            rows={[
              ['File', database.path],
              ['Size', formatBytes(database.bytes)],
              ['Write-ahead log', formatBytes(database.walBytes)],
              ['Journal', database.journalMode],
              [
                'Connections',
                database.pool
                  ? `${database.pool.active} active, ${database.pool.idle} idle, ${database.pool.max} max`
                  : null,
              ],
              ['Waiting', database.pool?.awaiting],
            ]}
          />
          <table className="mt-3 w-full text-sm">
            <tbody>
              {Object.entries(database.tables || {}).map(([table, n]) => (
                <tr key={table} className="border-t">
                  <td className="py-1 text-muted-foreground">{table}</td>
                  <td className="py-1 text-right font-mono text-xs tabular-nums">
                    {n === null ? '—' : n.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section
          title="Backups"
          action={
            <Button size="sm" variant="outline" onClick={runBackup} disabled={backingUp}>
              {backingUp ? 'Backing up…' : 'Back up now'}
            </Button>
          }
        >
          <Facts
            rows={[
              ['Schedule', backup.enabled ? `Daily at ${backup.time}` : 'Off'],
              ['Keep', `${backup.retention} most recent`],
              ['Directory', backup.directory],
            ]}
          />
          {backup.backups?.length ? (
            <table className="mt-3 w-full text-sm">
              <tbody>
                {backup.backups.map((b) => (
                  <tr key={b.name} className="border-t">
                    <td className="py-1 font-mono text-xs">{b.name}</td>
                    <td className="py-1 text-right text-xs text-muted-foreground">
                      {formatBytes(b.bytes)}
                    </td>
                    <td
                      className="py-1 pl-3 text-right text-xs text-muted-foreground"
                      title={fullTimestamp(b.modified)}
                    >
                      {timeAgo(b.modified)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No backups on disk.</p>
          )}
        </Section>

        <Section title="Media">
          <Facts
            rows={[
              ['Directory', media.directory],
              ['Files', `${media.files.toLocaleString()}, ${formatBytes(media.bytes)}`],
              [
                'Unreferenced',
                media.orphans
                  ? `${media.orphans} files, ${formatBytes(media.orphanBytes)}, collected at next restart`
                  : 'None',
              ],
            ]}
          />
        </Section>

        <Section title="Open documents">
          <ListPager {...pagedLocks} onPage={pagedLocks.setPage} position="top" />
          {locks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is holding a document.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {pagedLocks.pageItems.map((l) => (
                  <tr key={l.documentId} className="border-t">
                    <td className="py-1 font-mono text-xs">{l.documentId}</td>
                    <td className="py-1 pl-3">{l.userId}</td>
                    <td className="py-1 pl-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => breakLock(l)}>
                        Release
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ListPager {...pagedLocks} onPage={pagedLocks.setPage} position="bottom" />
        </Section>

        <Section
          title="Failed attempts"
          action={
            buckets.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => clearBucket(undefined, undefined)}>
                Clear all
              </Button>
            )
          }
        >
          {buckets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded in the last 15 minutes.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {pagedBuckets.pageItems.map((b, i) => (
                  <tr key={`${b.kind}-${b.ip}-${b.userId || ''}-${i}`} className="border-t">
                    <td className="py-1 text-muted-foreground">{b.kind}</td>
                    <td className="py-1 pl-3 font-mono text-xs">{b.ip}</td>
                    <td className="py-1 pl-3">{b.userId || ''}</td>
                    <td className="py-1 pl-3 tabular-nums">
                      {b.failures} of {b.limit}
                    </td>
                    <td className="py-1 pl-3">
                      {b.blocked && <Badge variant="destructive">Blocked</Badge>}
                    </td>
                    <td className="py-1 pl-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => clearBucket(b.ip, b.userId)}>
                        Clear
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ListPager {...pagedBuckets} onPage={pagedBuckets.setPage} position="bottom" />
        </Section>
      </div>

      <Section title="Log">
        {logs?.error ? (
          <p className="text-sm text-muted-foreground">{logs.error}</p>
        ) : (
          <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs leading-relaxed">
            {(logs?.lines || []).join('\n')}
          </pre>
        )}
      </Section>
    </div>
  );
};
