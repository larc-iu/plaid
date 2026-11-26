import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { compareNames, textIncludes } from '@ui/domain/collation.js';
import { t, msg } from '@ui/lib/i18n.js';
import { ProjectLink } from './ProjectLink';

// Services register per project, so "is the analyze service up" can only be
// answered one project at a time. This asks every project at once.
//
// A registration is identified by (project, service id), so a service used on
// forty projects is forty rows in the registry. One row per SERVICE here, with
// its projects underneath: the identity a person has in mind is the service,
// and the project count is a property of it rather than a reason to repeat it.

// An entry with `seen: false` is a claim whose registration was forgotten:
// there is nothing to forget, only the id to release.
const isRegistration = (e) => e.seen !== false;

const tokens = (n) => (typeof n === 'number' ? t('{n, number} tokens', { n }) : null);

// What a registration says it runs, in the order the expanded row lists it.
const FACTS = [
  [msg('Model'), (x) => x.model],
  [msg('Version'), (x) => x.version],
  [msg('Model key'), (x) => x.modelPool],
  [msg('Output limit'), (x) => tokens(x.maxOutputTokens)],
  [msg('Context window'), (x) => tokens(x.contextWindow)],
  [msg('Reasoning effort'), (x) => x.reasoningEffort],
  [msg('Web search'), (x) => x.webSearch],
];

const factsOf = (entry) =>
  FACTS.map(([label, read]) => [label, read(entry.extras || {})]).filter(([, v]) => v);

const byFreshest = (a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));

const groupByService = (registrations) => {
  const byId = new Map();
  registrations.forEach((r) => {
    if (!byId.has(r.serviceId)) byId.set(r.serviceId, []);
    byId.get(r.serviceId).push(r);
  });
  return [...byId.entries()].map(([serviceId, entries]) => {
    const online = entries.filter((e) => e.online);
    // The name and description are stored per registration. They agree in
    // practice, so the freshest one speaks for the service.
    const freshest = [...entries].sort(byFreshest)[0];
    // What it runs: an online registration's word, else the freshest one's.
    const runs = ([...online].sort(byFreshest)[0] || freshest)?.extras || {};
    const differ = (key) => new Set(online.map((e) => e.extras?.[key] ?? '')).size > 1;
    return {
      serviceId,
      serviceName: freshest?.serviceName || serviceId,
      description: freshest?.description || '',
      tasks: [...new Set(entries.flatMap((e) => e.extras?.tasks || []))],
      model: runs.model || '',
      version: runs.version || '',
      modelPool: runs.modelPool || '',
      versionsDiffer: differ('version') || differ('model'),
      entries: [...entries].sort((a, b) => compareNames(a.project.name, b.project.name)),
      projects: entries.filter(isRegistration).length,
      online: online.length,
      lastSeenAt: entries
        .map((e) => e.lastSeenAt)
        .filter(Boolean)
        .sort()
        .pop(),
    };
  });
};

export const AdminServices = ({ client, currentUser }) => {
  const confirm = useConfirm();
  const [registrations, setRegistrations] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const projects = (await client.projects.list()) || [];
      const found = await Promise.all(
        projects.map((p) =>
          client.messages
            .discoverServices(p.id)
            .then((services) => (services || []).map((s) => ({ ...s, project: p })))
            .catch(() => []),
        ),
      );
      setRegistrations(found.flat());
    } catch (err) {
      console.error('Error loading services:', err);
      notifyError(humanizeError(err), t('Failed to load the services'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => groupByService(registrations), [registrations]);

  const discardOne = async (entry) => {
    const ok = await confirm({
      title: t('Forget this registration?'),
      description: t('{service} is removed from {project}. It reappears if it connects again.', {
        service: entry.serviceName,
        project: entry.project.name,
      }),
      confirmLabel: t('Forget'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.messages.discardService(entry.project.id, entry.serviceId);
      notifySuccess(t('Registration forgotten'));
      await load();
    } catch (err) {
      notifyError(humanizeError(err), t('Failed to forget the registration'));
    }
  };

  // R10: a service id belongs to the account that first connected it, and
  // nobody else can run a service under it until an admin releases it.
  const heldByOther = (entry) =>
    !entry.online && !!entry.claimedBy && entry.claimedBy !== currentUser?.id;

  const releaseOne = async (entry) => {
    const ok = await confirm({
      title: t('Release this service id?'),
      description: t(
        '{id} on {project} belongs to {owner}. The next account to connect it holds it.',
        { id: entry.serviceId, project: entry.project.name, owner: entry.claimedBy },
      ),
      confirmLabel: t('Release'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.messages.releaseService(entry.project.id, entry.serviceId);
      notifySuccess(t('Service id released'));
      await load();
    } catch (err) {
      notifyError(humanizeError(err), t('Failed to release the service id'));
    }
  };

  const discardEverywhere = async (row) => {
    const offline = row.entries.filter((e) => !e.online && isRegistration(e));
    const ok = await confirm({
      title: t('Forget {service} everywhere?', { service: row.serviceName }),
      description: t(
        'Removes {n, plural, one {# registration} other {# registrations}}, on every project where it is offline. Each reappears if it connects again.',
        { n: offline.length },
      ),
      confirmLabel: t('Forget {n}', { n: offline.length }),
      destructive: true,
    });
    if (!ok) return;
    const failed = [];
    for (const entry of offline) {
      try {
        await client.messages.discardService(entry.project.id, entry.serviceId);
      } catch {
        failed.push(entry.project.name);
      }
    }
    if (failed.length) {
      notifyError(
        t('{n} could not be removed: {names}', { n: failed.length, names: failed.join(', ') }),
        t('Partly done'),
      );
    } else {
      notifySuccess(
        t('{n, plural, one {# registration} other {# registrations}} forgotten', {
          n: offline.length,
        }),
      );
    }
    await load();
  };

  const columns = [
    {
      key: 'name',
      label: t('Service'),
      sort: (r) => r.serviceName.toLowerCase(),
      render: (r) => (
        <div>
          <div className="flex items-center gap-2">
            <Badge variant={r.online > 0 ? 'default' : 'outline'}>
              {r.online > 0 ? t('Online') : t('Offline')}
            </Badge>
            <span className="font-medium">{r.serviceName}</span>
          </div>
          <p className="pt-0.5 font-mono text-xs text-muted-foreground">{r.serviceId}</p>
        </div>
      ),
    },
    {
      key: 'model',
      label: t('Model'),
      sort: (r) => r.model,
      render: (r) => r.model,
    },
    {
      key: 'version',
      label: t('Version'),
      sort: (r) => r.version,
      render: (r) => (
        <>
          <span className="font-mono text-xs">{r.version}</span>
          {r.versionsDiffer && (
            <span data-differ className="pl-2 text-muted-foreground">
              {t('Versions differ')}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'modelPool',
      label: t('Model key'),
      sort: (r) => r.modelPool,
      render: (r) => r.modelPool,
    },
    {
      key: 'tasks',
      label: t('Tasks'),
      sort: (r) => r.tasks.join(', '),
      className: 'text-muted-foreground',
      render: (r) => r.tasks.join(', '),
    },
    {
      key: 'projects',
      label: t('Projects'),
      sort: (r) => r.projects,
      align: 'right',
      className: 'tabular-nums',
      render: (r) =>
        r.online > 0
          ? t('{online} of {total}', { online: r.online, total: r.projects })
          : r.projects,
    },
    {
      key: 'lastSeen',
      label: t('Last seen'),
      sort: (r) =>
        r.online > 0 ? Infinity : r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : null,
      className: 'text-muted-foreground',
      render: (r) =>
        r.online > 0 ? (
          t('Now')
        ) : (
          <span title={fullTimestamp(r.lastSeenAt)}>
            {r.lastSeenAt ? timeAgo(r.lastSeenAt) : ''}
          </span>
        ),
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-32',
      align: 'right',
      render: (r) =>
        r.entries.some((e) => !e.online && isRegistration(e)) ? (
          <Button size="sm" variant="ghost" onClick={() => discardEverywhere(r)}>
            {t('Forget offline')}
          </Button>
        ) : null,
    },
  ];

  const online = rows.filter((r) => r.online > 0).length;

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.serviceId}
      id="admin-services"
      defaultSort={{ key: 'lastSeen', dir: 'desc' }}
      search={{
        placeholder: t('Search services…'),
        match: (r, q) =>
          textIncludes(r.serviceName, q) ||
          textIncludes(r.serviceId, q) ||
          textIncludes(r.tasks.join(' '), q) ||
          r.entries.some((e) => textIncludes(e.project.name, q)),
      }}
      countLabel={(v) => t('{total} {n, plural, one {service} other {services}}', v)}
      empty={t('No project has seen a service.')}
      noMatch={t('No services match.')}
      loading={loading}
      actions={
        <>
          <span className="text-sm text-muted-foreground">
            {t('{online} online, {n, plural, one {# registration} other {# registrations}}', {
              online,
              n: registrations.filter(isRegistration).length,
            })}
          </span>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> {t('Refresh')}
          </Button>
        </>
      }
      expand={(r) => (
        <table className="w-full text-sm">
          <tbody>
            {r.entries.map((e) => (
              <tr key={e.project.id} className="border-b last:border-0">
                <td className="py-1 pr-3">
                  <Badge variant={e.online ? 'default' : 'outline'}>
                    {e.online ? t('Online') : t('Offline')}
                  </Badge>
                </td>
                <td className="py-1 pr-3">
                  <ProjectLink project={e.project} className="hover:underline">
                    {e.project.name}
                  </ProjectLink>
                </td>
                <td className="py-1 pr-3 text-muted-foreground" title={fullTimestamp(e.lastSeenAt)}>
                  {e.online ? t('Now') : e.lastSeenAt ? timeAgo(e.lastSeenAt) : ''}
                </td>
                <td className="py-1 pr-3 text-muted-foreground">
                  {e.claimedBy ? t('Held by {name}', { name: e.claimedBy }) : ''}
                </td>
                <td className="py-1 pr-3">
                  <div data-facts className="flex flex-wrap gap-x-3">
                    {factsOf(e).map(([label, value]) => (
                      <span key={label} data-fact>
                        <span className="text-muted-foreground">{t(label)}</span> {value}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-1 text-right">
                  {heldByOther(e) && (
                    <Button size="sm" variant="ghost" onClick={() => releaseOne(e)}>
                      {t('Release')}
                    </Button>
                  )}
                  {!e.online && isRegistration(e) && (
                    <Button size="sm" variant="ghost" onClick={() => discardOne(e)}>
                      {t('Forget')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
};
