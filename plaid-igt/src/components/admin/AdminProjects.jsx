import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager, SortHeader } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { useStickySort, listPrefKey } from '@/hooks/useStickyState';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { PLAID_NAMESPACE } from '@larc-iu/plaid-client';

// Every project on the server, including the ones this admin has no role in.
// An admin's project list already returns all of them; what is missing
// everywhere else is who is on each, which app owns it, and whether anyone has
// touched it lately.

const COLUMNS = ['name', 'app', 'members', 'documents', 'updated'];

// Which app's shape a project carries, from the cross-app role vocabulary. A
// project with no roles has been created but never set up.
const appOf = (project) => {
  const roles = new Set();
  (project.textLayers || []).forEach((tl) => {
    const role = tl.config?.[PLAID_NAMESPACE]?.role;
    if (role) roles.add(role);
    (tl.tokenLayers || []).forEach((tok) => {
      const r = tok.config?.[PLAID_NAMESPACE]?.role;
      if (r) roles.add(r);
    });
  });
  if (roles.has('morpheme') || roles.has('time-alignment')) return 'IGT';
  if (roles.size > 0) return 'Shared';
  return 'Unconfigured';
};

const memberCount = (p) =>
  new Set([...(p.readers || []), ...(p.writers || []), ...(p.maintainers || [])]).size;

export const AdminProjects = ({ client, currentUser }) => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, onSort] = useStickySort(
    listPrefKey('sort', 'admin-projects'),
    { key: 'updated', dir: 'desc' },
    COLUMNS,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // documentCount and lastModified come back on the project itself, so the
      // whole table is one request. An admin's project list is every project.
      const page = await client.projects.listPage({ limit: 1000 });
      setProjects(page.entries || []);
    } catch (err) {
      console.error('Error loading projects:', err);
      notifyError(err.message || 'Failed to load projects', 'Error');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const joinAsMaintainer = async (project) => {
    try {
      await client.projects.addMaintainer(project.id, currentUser.id);
      notifySuccess(`You are a maintainer of ${project.name}`, 'Added');
      await load();
    } catch (err) {
      notifyError(err.message || 'Failed to add you to the project', 'Error');
    }
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = projects
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .map((p) => ({
        ...p,
        app: appOf(p),
        members: memberCount(p),
        documents: p.documentCount ?? null,
        updated: p.lastModified ?? null,
      }));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av === bv) return a.name.localeCompare(b.name);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * dir;
    });
  }, [projects, search, sort]);

  const paged = usePagedList(rows, { resetKey: `${search}:${sort.key}:${sort.dir}` });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search projects…"
          className="max-w-xs"
        />
        <ListCount shown={rows.length} total={projects.length} noun="project" />
      </div>

      <div className="rounded-md border">
        <ListPager {...paged} onPage={paged.setPage} position="top" />
        {loading && projects.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No projects match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">
                  <SortHeader field="name" label="Name" sort={sort} onSort={onSort} />
                </th>
                <th className="px-3 py-2">
                  <SortHeader field="app" label="Shape" sort={sort} onSort={onSort} />
                </th>
                <th className="px-3 py-2">
                  <SortHeader field="members" label="People" sort={sort} onSort={onSort} />
                </th>
                <th className="px-3 py-2">
                  <SortHeader field="documents" label="Documents" sort={sort} onSort={onSort} />
                </th>
                <th className="px-3 py-2">
                  <SortHeader field="updated" label="Last change" sort={sort} onSort={onSort} />
                </th>
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {paged.pageItems.map((p) => {
                const mine =
                  p.maintainers?.includes(currentUser?.id) ||
                  p.writers?.includes(currentUser?.id) ||
                  p.readers?.includes(currentUser?.id);
                return (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-accent/40">
                    <td className="px-3 py-2">
                      <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={p.app === 'Unconfigured' ? 'outline' : 'secondary'}>
                        {p.app}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{p.members}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {p.documents === null ? '' : p.documents.toLocaleString()}
                    </td>
                    <td
                      className="px-3 py-2 text-muted-foreground"
                      title={fullTimestamp(p.updated)}
                    >
                      {p.updated ? timeAgo(p.updated) : 'Never'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!mine && (
                        <Button size="sm" variant="ghost" onClick={() => joinAsMaintainer(p)}>
                          Join
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <ListPager {...paged} onPage={paged.setPage} position="bottom" />
      </div>
    </div>
  );
};
