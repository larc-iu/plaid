import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { notifyError } from '@/utils/feedback';

// Vocabularies are shared across projects, so which projects use one is
// invisible from inside any of them. This is the join, plus the vocabularies
// no project uses at all.

export const AdminVocabularies = ({ client }) => {
  const [vocabs, setVocabs] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vocabList, projectPage] = await Promise.all([
        client.vocabLayers.list(),
        client.projects.listPage({ limit: 1000 }),
      ]);
      setVocabs(vocabList || []);
      setProjects(projectPage.entries || []);
    } catch (err) {
      console.error('Error loading vocabularies:', err);
      notifyError(err.message || 'Failed to load vocabularies', 'Error');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const usedBy = new Map();
    projects.forEach((p) => {
      (p.vocabs || []).forEach((v) => {
        const id = v.id || v;
        if (!usedBy.has(id)) usedBy.set(id, []);
        usedBy.get(id).push(p);
      });
    });
    const q = search.trim().toLowerCase();
    return vocabs
      .filter((v) => (q ? (v.name || '').toLowerCase().includes(q) : true))
      .map((v) => ({ ...v, projects: usedBy.get(v.id) || [] }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [vocabs, projects, search]);

  const paged = usePagedList(rows, { resetKey: search });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search vocabularies…"
          className="max-w-xs"
        />
        <ListCount shown={rows.length} total={vocabs.length} noun="vocabulary" />
      </div>

      <div className="rounded-md border">
        <ListPager {...paged} onPage={paged.setPage} position="top" />
        {loading && vocabs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No vocabularies match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Maintainers</th>
                <th className="px-3 py-2 font-medium">Used by</th>
              </tr>
            </thead>
            <tbody>
              {paged.pageItems.map((v) => (
                <tr key={v.id} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="px-3 py-2">
                    <Link to={`/vocabularies/${v.id}`} className="font-medium hover:underline">
                      {v.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {(v.maintainers || []).join(', ') || 'None'}
                  </td>
                  <td className="px-3 py-2">
                    {v.projects.length === 0 ? (
                      <Badge variant="outline">No project</Badge>
                    ) : (
                      <span className="flex flex-wrap gap-x-2 gap-y-1">
                        {v.projects.map((p) => (
                          <Link
                            key={p.id}
                            to={`/projects/${p.id}`}
                            className="text-muted-foreground hover:underline"
                          >
                            {p.name}
                          </Link>
                        ))}
                      </span>
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
