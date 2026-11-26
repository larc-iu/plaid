import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { formatBytes } from '@/utils/formatBytes';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifySuccess, notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
import { isUnknownOutcome, isUnreachable, statusOf } from '@ui/lib/errors.js';
import { formatElapsed } from '@ui/hooks/useRunProgress.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { readInitialized } from '../../domain/igtConfig';
import { projectTarget } from './projectTarget';
import { t, msg } from '@ui/lib/i18n.js';

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

// A backup whose answer did not come (a proxy gave up first) or that found
// one already running is watched for on disk: the report is read again this
// often, for this long, until a backup that was not there before shows up.
// The report counts every table, so not more often than this.
const BACKUP_POLL_MS = 15000;
const BACKUP_POLL_FOR_MS = 30 * 60 * 1000;

// A nightly backup older than this is a missed night.
const BACKUP_STALE_MS = 26 * 3600 * 1000;

// What is broken about the backups, or null. Ages are on the server's clock,
// its start plus its uptime, so a browser's wrong clock cannot raise it.
const backupProblem = (backup, jvm) => {
  if (!backup.enabled) return null;
  if (backup.lastRun && !backup.lastRun.ok) return t('The last backup failed.');
  const serverNow = Date.parse(jvm.startedAt) + jvm.uptimeMs;
  const newest = backup.backups?.[0] ? Date.parse(backup.backups[0].modified) : -Infinity;
  if (jvm.uptimeMs > BACKUP_STALE_MS && serverNow - newest > BACKUP_STALE_MS) {
    return t('No backup in the last 26 hours.');
  }
  return null;
};

const lastRunText = ({ at, ok, scheduled }) => {
  const when = timeAgo(at);
  if (scheduled) return ok ? t('{when}, Succeeded', { when }) : t('{when}, Failed', { when });
  return ok ? t('{when}, Succeeded, by hand', { when }) : t('{when}, Failed, by hand', { when });
};

// Where an open document's project and the document itself lead. A project
// this app owns opens through the router, another app's project in that app
// as a page load (as on the Projects tab). Only this app's documents link:
// another app's project has no route here, and the setup wizard is the wrong
// place to send its documents. A project not in `projects` opens here.
const lockLinks = (lock, projects) => {
  const project = projects.get(lock.projectId);
  const ours = project ? readInitialized(project.config) : false;
  // Where every admin project link leads (`projectTarget`).
  const target = project ? projectTarget(project) : `/projects/${lock.projectId}`;
  return {
    project: typeof target === 'string' ? { to: target } : target,
    document: ours ? `/projects/${lock.projectId}/documents/${lock.documentId}` : null,
  };
};

const duration = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return t('{d}d {h}h', { d, h });
  if (h) return t('{h}h {m}m', { h, m });
  return t('{m}m', { m });
};

export const AdminServer = ({ client }) => {
  const confirm = useConfirm();
  const [report, setReport] = useState(null);
  const [locks, setLocks] = useState([]);
  // Every project by id, read only while a document is open, for where its
  // links lead.
  const [projects, setProjects] = useState(() => new Map());
  const [rateLimits, setRateLimits] = useState(null);
  const [loading, setLoading] = useState(true);
  // When the backup this page is waiting for was started, null when none.
  const [backingUpSince, setBackingUpSince] = useState(null);
  const backingUp = backingUpSince != null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!backingUpSince) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [backingUpSince]);
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [srv, lk, rl] = await Promise.all([
        client.admin.server(),
        client.admin.locks(),
        client.admin.rateLimits(),
      ]);
      const open = lk.entries || [];
      const all = open.length ? (await client.projects.list()) || [] : [];
      setReport(srv);
      setLocks(open);
      setProjects(new Map(all.map((p) => [p.id, p])));
      setRateLimits(rl);
    } catch (err) {
      console.error('Error loading server report:', err);
      notifyError(humanizeError(err), t('Failed to load the server report'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  // Read the report until a backup not in `known` is on disk. Resolves to it,
  // or null once the page is left or the wait is over.
  const waitForNewBackup = async (known) => {
    const until = Date.now() + BACKUP_POLL_FOR_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, BACKUP_POLL_MS));
      if (!shown.current) return null;
      try {
        const srv = await client.admin.server();
        if (!shown.current) return null;
        const fresh = srv.backup?.backups?.find((b) => !known.has(b.name));
        if (fresh) {
          setReport(srv);
          return fresh;
        }
      } catch (err) {
        console.error('Error reading the server report:', err);
      }
    }
    return null;
  };

  // The server answers once the zip is written. When that answer does not
  // come (a proxy gives up first), or a backup is already running (409), the
  // backup goes on, and the page waits for its file instead of calling it
  // failed. A backup the server could not write answers 500 with the backup
  // block and ok: false, and its reason is only in the log.
  const runBackup = async () => {
    const notWritten = () =>
      notifyError(
        t('The server could not write the backup. Check the log.'),
        t('Failed to back up'),
      );
    const known = new Set((report?.backup?.backups || []).map((b) => b.name));
    setBackingUpSince(Date.now());
    try {
      let result;
      try {
        result = await client.admin.backup();
      } catch (err) {
        const running = statusOf(err) === 409;
        if (!running && !isUnknownOutcome(err) && !isUnreachable(err)) throw err;
        if (running)
          notifyWarning(t('Its file shows here when it is written.'), t('Backup already running'));
        const fresh = await waitForNewBackup(known);
        if (fresh) notifySuccess(fresh.name, t('Backup complete'));
        else if (shown.current) {
          notifyWarning(
            t('No new backup on disk. Check the server log.'),
            t('Backup not confirmed'),
          );
        }
        return;
      }
      setReport((r) => (r ? { ...r, backup: result } : r));
      if (result.ok) {
        notifySuccess(result.backups?.[0]?.name || t('Backup written'), t('Backup complete'));
      } else {
        notWritten();
      }
    } catch (err) {
      if (statusOf(err) === 500 && err.responseData?.ok === false) {
        setReport((r) => (r ? { ...r, backup: err.responseData } : r));
        notWritten();
      } else notifyError(humanizeError(err), t('Failed to back up'));
    } finally {
      if (shown.current) setBackingUpSince(null);
    }
  };

  const breakLock = async (lock) => {
    const ok = await confirm({
      title: t('Release this lock?'),
      description: t('Held by {name}. Releasing lets anyone write to the document again.', {
        name: lock.userName || lock.userId,
      }),
      confirmLabel: t('Release'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.admin.releaseLock(lock.documentId);
      setLocks((ls) => ls.filter((l) => l.documentId !== lock.documentId));
      notifySuccess(t('Lock released'));
    } catch (err) {
      notifyError(humanizeError(err), t('Failed to release the lock'));
    }
  };

  const clearBucket = async (ip, userId) => {
    try {
      await client.admin.clearRateLimits({ ip, userId });
      setRateLimits(await client.admin.rateLimits());
      // One account's row also clears the address's own buckets (core's
      // `clear-buckets!`), so its toast names them. An address clears all.
      if (userId) {
        notifySuccess(
          t('Also cleared: Address and Invite failures from {ip}.', { ip }),
          t('{user} at {ip} cleared', { user: userId, ip }),
        );
      } else notifySuccess(ip ? t('{ip} cleared', { ip }) : t('Every address cleared'));
    } catch (err) {
      notifyError(humanizeError(err), t('Failed to clear'));
    }
  };

  const buckets = useMemo(
    () => [
      ...(rateLimits?.logins || []).map((b) => ({ ...b, kind: msg('Sign-in') })),
      ...(rateLimits?.ips || []).map((b) => ({ ...b, kind: msg('Address') })),
      ...(rateLimits?.invites || []).map((b) => ({ ...b, kind: msg('Invite') })),
    ],
    [rateLimits],
  );
  if (loading && !report) return <Loading className="px-0 py-8" />;
  if (!report) return null;

  const { jvm, database, media, backup, settings } = report;
  const problem = backupProblem(backup, jvm);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> {t('Refresh')}
        </Button>
      </div>
      {problem && <Notice tone="error">{problem}</Notice>}

      <div className="grid gap-4 md:grid-cols-2">
        <Section title={t('Server')}>
          <Facts
            rows={[
              [
                t('Version'),
                report.commit ? (
                  <>
                    {report.version} (<span title={report.commit}>{report.commit.slice(0, 9)}</span>
                    )
                  </>
                ) : (
                  report.version
                ),
              ],
              [
                t('Migrations'),
                database.migrations
                  ? t('{applied} applied, latest {latest}', {
                      applied: database.migrations.applied,
                      latest: database.migrations.latest,
                    })
                  : null,
              ],
              [
                t('Uptime'),
                t('{uptime} (since {time})', {
                  uptime: duration(jvm.uptimeMs),
                  time: fullTimestamp(jvm.startedAt),
                }),
              ],
              ['Java', jvm.java],
              [
                t('Heap'),
                t('{used} of {max}', {
                  used: formatBytes(jvm.heapUsed),
                  max: formatBytes(jvm.heapMax),
                }),
              ],
              [t('Port'), settings.port],
              [t('Log level'), settings.logLevel],
              [
                t('Session lifetime'),
                t('{n} days', { n: Math.round((settings.jwtTtlSeconds || 0) / 86400) }),
              ],
              [
                t('Editing lock'),
                t('{n}s', { n: Math.round(settings.effectiveLockExpirationMs / 1000) }),
              ],
              ['OpenAPI', settings.openapiExposed ? t('Exposed') : t('Hidden')],
              [
                t('Upload limit'),
                t('{media} MB media, {json} MB JSON', {
                  media: settings.mediaMaxFileMb,
                  json: settings.maxJsonBodyMb,
                }),
              ],
              [
                t('Private data limit'),
                // In the unit of `[user_data] max_value_mb`, the setting
                // that raises it, and of the upload limits above.
                settings.userDataValueBytes
                  ? t('{n} MB per value', {
                      n: Math.round((settings.userDataValueBytes / 1048576) * 10) / 10,
                    })
                  : null,
              ],
              [t('CORS origins'), (settings.corsAllowedOrigins || []).join(', ') || t('None')],
            ]}
          />
        </Section>

        <Section title={t('Database')}>
          <Facts
            rows={[
              [t('File'), database.path],
              [t('Size'), formatBytes(database.bytes)],
              [t('Write-ahead log'), formatBytes(database.walBytes)],
              [t('Journal'), database.journalMode],
              [
                t('Connections'),
                database.pool
                  ? t('{active} active, {idle} idle, {max} max', {
                      active: database.pool.active,
                      idle: database.pool.idle,
                      max: database.pool.max,
                    })
                  : null,
              ],
              [t('Waiting'), database.pool?.awaiting],
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
          title={t('Backups')}
          action={
            <div className="flex items-center gap-2">
              {backingUp && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatElapsed(now - backingUpSince)}
                </span>
              )}
              <Button size="sm" variant="outline" onClick={runBackup} disabled={backingUp}>
                {backingUp ? t('Backing up…') : t('Back up now')}
              </Button>
            </div>
          }
        >
          <Facts
            rows={[
              [
                t('Schedule'),
                backup.enabled ? t('Daily at {time}', { time: backup.time }) : t('Off'),
              ],
              [
                t('Last run'),
                backup.lastRun ? (
                  <span title={fullTimestamp(backup.lastRun.at)}>
                    {lastRunText(backup.lastRun)}
                  </span>
                ) : null,
              ],
              [t('Keep'), t('{n} most recent', { n: backup.retention })],
              [t('Directory'), backup.directory],
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
            <p className="mt-3 text-sm text-muted-foreground">{t('No backups on disk.')}</p>
          )}
        </Section>

        <Section title={t('Media')}>
          <Facts
            rows={[
              [t('Directory'), media.directory],
              [t('Files'), `${media.files.toLocaleString()}, ${formatBytes(media.bytes)}`],
              [
                t('Unreferenced'),
                media.orphans
                  ? t('{n} files, {size}, collected at next restart', {
                      n: media.orphans,
                      size: formatBytes(media.orphanBytes),
                    })
                  : t('None'),
              ],
            ]}
          />
        </Section>

        <DataTable
          title={t('Open documents')}
          rows={locks}
          columns={[
            {
              key: 'document',
              label: t('Document'),
              sort: (l) => (l.documentName || '').toLowerCase(),
              render: (l) => {
                const to = lockLinks(l, projects).document;
                const name = l.documentName || l.documentId;
                return to ? (
                  <Link to={to} dir="auto" className="hover:underline">
                    {name}
                  </Link>
                ) : (
                  <span dir="auto">{name}</span>
                );
              },
            },
            {
              key: 'project',
              label: t('Project'),
              sort: (l) => (l.projectName || '').toLowerCase(),
              render: (l) => {
                if (!l.projectId) return null;
                const { href, to } = lockLinks(l, projects).project;
                // Another app is a full page load, so a plain anchor.
                return href ? (
                  <a href={href} dir="auto" className="hover:underline">
                    {l.projectName}
                  </a>
                ) : (
                  <Link to={to} dir="auto" className="hover:underline">
                    {l.projectName}
                  </Link>
                );
              },
            },
            {
              key: 'user',
              label: t('Held by'),
              sort: (l) => (l.userName || l.userId).toLowerCase(),
              render: (l) => <span title={l.userId}>{l.userName || l.userId}</span>,
            },
            {
              key: 'expires',
              label: t('Expires'),
              sort: (l) => l.expiresAt,
              className: 'text-xs text-muted-foreground',
              render: (l) => <span title={fullTimestamp(l.expiresAt)}>{timeAgo(l.expiresAt)}</span>,
            },
            {
              key: 'actions',
              label: '',
              headerClassName: 'w-24',
              align: 'right',
              render: (l) => (
                <Button size="sm" variant="ghost" onClick={() => breakLock(l)}>
                  {t('Release')}
                </Button>
              ),
            },
          ]}
          rowKey={(l) => l.documentId}
          id="admin-locks"
          defaultSort={{ key: 'user', dir: 'asc' }}
          countLabel={(v) => t('{total} {n, plural, one {document} other {documents}}', v)}
          empty={t('Nobody is holding a document.')}
        />

        <DataTable
          title={t('Failed attempts')}
          rows={buckets}
          columns={[
            {
              key: 'kind',
              label: t('Kind'),
              sort: (b) => b.kind,
              className: 'text-muted-foreground',
              render: (b) => t(b.kind),
            },
            {
              key: 'ip',
              label: t('Address'),
              sort: (b) => b.ip,
              className: 'font-mono text-xs',
              render: (b) => b.ip,
            },
            {
              key: 'user',
              label: t('Account'),
              sort: (b) => b.userId || '',
              render: (b) => b.userId || '',
            },
            {
              key: 'failures',
              label: t('Failures'),
              sort: (b) => b.failures,
              align: 'right',
              className: 'tabular-nums',
              render: (b) => t('{failures} of {limit}', { failures: b.failures, limit: b.limit }),
            },
            {
              key: 'blocked',
              label: t('Blocked'),
              sort: (b) => (b.blocked ? 0 : 1),
              render: (b) =>
                b.blocked ? <Badge variant="destructive">{t('Blocked')}</Badge> : null,
            },
            {
              key: 'actions',
              label: '',
              headerClassName: 'w-20',
              align: 'right',
              render: (b) => (
                <Button size="sm" variant="ghost" onClick={() => clearBucket(b.ip, b.userId)}>
                  {t('Clear')}
                </Button>
              ),
            },
          ]}
          rowKey={(b) => `${b.kind}:${b.ip}:${b.userId || ''}`}
          id="admin-rate-limits"
          defaultSort={{ key: 'failures', dir: 'desc' }}
          countLabel={(v) => t('{total} {n, plural, one {address} other {addresses}}', v)}
          empty={t('Nothing recorded in the last 15 minutes.')}
          actions={
            buckets.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => clearBucket(undefined, undefined)}>
                {t('Clear all')}
              </Button>
            )
          }
        />
      </div>
    </div>
  );
};
