import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager, SortHeader } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { useStickySort, listPrefKey } from '@/hooks/useStickyState';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { findBaselineTextLayer, readInitialized } from '../../domain/igtConfig';

// Every project on the server, including the ones this admin has no role in.
// An admin's project list already returns all of them; what is missing
// everywhere else is who is on each, which app owns it, and whether anyone has
// touched it lately.

const COLUMNS = ['name', 'app', 'members', 'documents', 'updated'];

// Whether this app set the project up, which is the only thing it can say for
// certain. A project carrying the shared layer roles that IGT did NOT set up
// belongs to another app on the same substrate (plaid-ud), and guessing which
// from the roles alone gets it wrong: UD projects carry morpheme layers too.
const shapeOf = (project) => {
  if (readInitialized(project.config)) return 'IGT';
  return findBaselineTextLayer(project.textLayers || []) ? 'Other app' : 'Not set up';
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
      // documentCount and lastModified come back on the project itself, so
      // nothing else has to be asked per row. An admin's project list is every
      // project on the server.
      setProjects((await client.projects.list()) || []);
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
        app: shapeOf(p),
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
                      <Badge variant={p.app === 'IGT' ? 'secondary' : 'outline'}>{p.app}</Badge>
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
