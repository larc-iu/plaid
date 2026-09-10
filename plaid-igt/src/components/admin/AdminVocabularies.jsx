import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/ui/data-table';
import { notifyError } from '@/utils/feedback';

// Vocabularies are shared across projects, so which projects use one is
// invisible from inside any of them. This is the join, plus the vocabularies
// no project uses at all.

export const AdminVocabularies = ({ client }) => {
  const [vocabs, setVocabs] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vocabList, projectList] = await Promise.all([
        client.vocabLayers.list(),
        client.projects.list(),
      ]);
      setVocabs(vocabList || []);
      setProjects(projectList || []);
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
    return vocabs.map((v) => ({ ...v, projects: usedBy.get(v.id) || [] }));
  }, [vocabs, projects]);

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sort: (v) => (v.name || '').toLowerCase(),
      render: (v) => (
        <Link to={`/vocabularies/${v.id}`} className="font-medium hover:underline">
          {v.name}
        </Link>
      ),
    },
    {
      key: 'maintainers',
      label: 'Maintainers',
      sort: (v) => (v.maintainers || []).length,
      className: 'text-muted-foreground',
      render: (v) => (v.maintainers || []).join(', ') || 'None',
    },
    {
      key: 'projects',
      label: 'Used by',
      sort: (v) => v.projects.length,
      render: (v) =>
        v.projects.length === 0 ? (
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
        ),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(v) => v.id}
      id="admin-vocabularies"
      defaultSort={{ key: 'name', dir: 'asc' }}
      search={{
        placeholder: 'Search vocabularies…',
        match: (v, q) => (v.name || '').toLowerCase().includes(q),
      }}
      noun="vocabulary"
      empty="No vocabularies."
      loading={loading}
    />
  );
};
