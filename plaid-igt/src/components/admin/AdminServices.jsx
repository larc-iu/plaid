import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@/components/shared/ConfirmProvider';

// Services register per project, so "is the analyze service up" can only be
// answered one project at a time. This asks every project at once.
//
// A registration is identified by (project, service id), so a service used on
// forty projects is forty rows in the registry. One row per SERVICE here, with
// its projects underneath: the identity a person has in mind is the service,
// and the project count is a property of it rather than a reason to repeat it.

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
    const freshest = [...entries].sort((a, b) =>
      String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')),
    )[0];
    return {
      serviceId,
      serviceName: freshest?.serviceName || serviceId,
      description: freshest?.description || '',
      tasks: [...new Set(entries.flatMap((e) => e.extras?.tasks || []))],
      entries: [...entries].sort((a, b) => a.project.name.localeCompare(b.project.name)),
      projects: entries.length,
      online: online.length,
      lastSeenAt: entries
        .map((e) => e.lastSeenAt)
        .filter(Boolean)
        .sort()
        .pop(),
    };
  });
};

export const AdminServices = ({ client }) => {
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
      notifyError(err.message || 'Failed to load services', 'Error');
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
      title: 'Forget this registration?',
      description: `${entry.serviceName} is removed from ${entry.project.name}. It reappears if it connects again.`,
      confirmLabel: 'Forget',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.messages.discardService(entry.project.id, entry.serviceId);
      notifySuccess('Registration forgotten', 'Removed');
      await load();
    } catch (err) {
      notifyError(err.message || 'Failed to forget the registration', 'Error');
    }
  };

  const discardEverywhere = async (row) => {
    const offline = row.entries.filter((e) => !e.online);
    const ok = await confirm({
      title: `Forget ${row.serviceName} everywhere?`,
      description: `Removes ${offline.length} registrations, on every project where it is offline. Each reappears if it connects again.`,
      confirmLabel: `Forget ${offline.length}`,
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
      notifyError(`${failed.length} could not be removed: ${failed.join(', ')}`, 'Partly done');
    } else {
      notifySuccess(`${offline.length} registrations forgotten`, 'Removed');
    }
    await load();
  };

  const columns = [
    {
      key: 'name',
      label: 'Service',
      sort: (r) => r.serviceName.toLowerCase(),
      render: (r) => (
        <div>
          <div className="flex items-center gap-2">
            <Badge variant={r.online > 0 ? 'default' : 'outline'}>
              {r.online > 0 ? 'Online' : 'Offline'}
            </Badge>
            <span className="font-medium">{r.serviceName}</span>
          </div>
          <p className="pt-0.5 font-mono text-xs text-muted-foreground">{r.serviceId}</p>
        </div>
      ),
    },
    {
      key: 'tasks',
      label: 'Tasks',
      sort: (r) => r.tasks.join(', '),
      className: 'text-muted-foreground',
      render: (r) => r.tasks.join(', '),
    },
    {
      key: 'projects',
      label: 'Projects',
      sort: (r) => r.projects,
      align: 'right',
      className: 'tabular-nums',
      render: (r) => (r.online > 0 ? `${r.online} of ${r.projects}` : r.projects),
    },
    {
      key: 'lastSeen',
      label: 'Last seen',
      sort: (r) =>
        r.online > 0 ? Infinity : r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : null,
      className: 'text-muted-foreground',
      render: (r) =>
        r.online > 0 ? (
          'Now'
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
        r.entries.some((e) => !e.online) ? (
          <Button size="sm" variant="ghost" onClick={() => discardEverywhere(r)}>
            Forget offline
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
        placeholder: 'Search services…',
        match: (r, q) =>
          r.serviceName.toLowerCase().includes(q) ||
          r.serviceId.toLowerCase().includes(q) ||
          r.tasks.join(' ').toLowerCase().includes(q) ||
          r.entries.some((e) => e.project.name.toLowerCase().includes(q)),
      }}
      noun="service"
      empty="No project has seen a service."
      loading={loading}
      actions={
        <>
          <span className="text-sm text-muted-foreground">
            {online} online, {registrations.length} registrations
          </span>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Refresh
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
                    {e.online ? 'Online' : 'Offline'}
                  </Badge>
                </td>
                <td className="py-1 pr-3">
                  <Link to={`/projects/${e.project.id}`} className="hover:underline">
                    {e.project.name}
                  </Link>
                </td>
                <td className="py-1 pr-3 text-muted-foreground" title={fullTimestamp(e.lastSeenAt)}>
                  {e.online ? 'Now' : e.lastSeenAt ? timeAgo(e.lastSeenAt) : ''}
                </td>
                <td className="py-1 text-right">
                  {!e.online && (
                    <Button size="sm" variant="ghost" onClick={() => discardOne(e)}>
                      Forget
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
