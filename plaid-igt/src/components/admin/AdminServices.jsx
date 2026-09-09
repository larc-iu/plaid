import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@/components/shared/ConfirmProvider';

// Services register per project, so "is the analyze service up" can only be
// answered one project at a time. This asks every project at once.

export const AdminServices = ({ client }) => {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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
      setRows(
        found
          .flat()
          .sort(
            (a, b) =>
              Number(b.online) - Number(a.online) ||
              a.project.name.localeCompare(b.project.name) ||
              (a.serviceName || '').localeCompare(b.serviceName || ''),
          ),
      );
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

  const discard = async (row) => {
    const ok = await confirm({
      title: 'Forget this service?',
      description: `${row.serviceName} is removed from ${row.project.name}. It reappears if it connects again.`,
      confirmLabel: 'Forget',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.messages.discardService(row.project.id, row.serviceId);
      notifySuccess('Service forgotten', 'Removed');
      await load();
    } catch (err) {
      notifyError(err.message || 'Failed to forget the service', 'Error');
    }
  };

  const online = rows.filter((r) => r.online).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.serviceName || '').toLowerCase().includes(q) ||
        r.project.name.toLowerCase().includes(q) ||
        (r.extras?.tasks || []).join(' ').toLowerCase().includes(q),
    );
  }, [rows, search]);

  const paged = usePagedList(filtered, { resetKey: search });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search services…"
          className="max-w-xs"
        />
        <ListCount shown={filtered.length} total={rows.length} noun="service" />
        <span className="text-sm text-muted-foreground">
          {online} online, {rows.length - online} offline
        </span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="rounded-md border">
        <ListPager {...paged} onPage={paged.setPage} position="top" />
        {loading && rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {rows.length === 0 ? 'No project has seen a service.' : 'No services match.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Tasks</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {paged.pageItems.map((r) => (
                <tr key={`${r.project.id}:${r.serviceId}`} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={r.online ? 'default' : 'outline'}>
                        {r.online ? 'Online' : 'Offline'}
                      </Badge>
                      <span className="font-medium">{r.serviceName}</span>
                    </div>
                    {r.description && (
                      <p className="pl-1 pt-0.5 text-xs text-muted-foreground">{r.description}</p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link to={`/projects/${r.project.id}`} className="hover:underline">
                      {r.project.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {(r.extras?.tasks || []).join(', ')}
                  </td>
                  <td
                    className="px-3 py-2 text-muted-foreground"
                    title={fullTimestamp(r.lastSeenAt)}
                  >
                    {r.online ? 'Now' : r.lastSeenAt ? timeAgo(r.lastSeenAt) : ''}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!r.online && (
                      <Button size="sm" variant="ghost" onClick={() => discard(r)}>
                        Forget
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ListPager {...paged} onPage={paged.setPage} position="bottom" />
      </div>
    </div>
  );
};
