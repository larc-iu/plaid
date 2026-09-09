import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { listPrefKey } from '@/hooks/useStickyState';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { findBaselineTextLayer, readInitialized } from '../../domain/igtConfig';

// Every project on the server, including the ones this admin has no role in.
// An admin's project list already returns all of them; what is missing
// everywhere else is who is on each, which app owns it, and whether anyone has
// touched it lately.

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

  const isMember = (p) =>
    p.maintainers?.includes(currentUser?.id) ||
    p.writers?.includes(currentUser?.id) ||
    p.readers?.includes(currentUser?.id);

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sort: (p) => p.name.toLowerCase(),
      render: (p) => (
        <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
          {p.name}
        </Link>
      ),
    },
    {
      key: 'shape',
      label: 'Shape',
      sort: (p) => shapeOf(p),
      render: (p) => {
        const shape = shapeOf(p);
        return <Badge variant={shape === 'IGT' ? 'secondary' : 'outline'}>{shape}</Badge>;
      },
    },
    {
      key: 'members',
      label: 'People',
      sort: memberCount,
      align: 'right',
      className: 'tabular-nums',
      render: memberCount,
    },
    {
      key: 'documents',
      label: 'Documents',
      sort: (p) => p.documentCount ?? null,
      align: 'right',
      className: 'tabular-nums',
      render: (p) => (p.documentCount == null ? '' : p.documentCount.toLocaleString()),
    },
    {
      key: 'updated',
      label: 'Last change',
      sort: (p) => (p.lastModified ? new Date(p.lastModified).getTime() : null),
      className: 'text-muted-foreground',
      render: (p) => (
        <span title={fullTimestamp(p.lastModified)}>
          {p.lastModified ? timeAgo(p.lastModified) : 'Never'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-24',
      align: 'right',
      render: (p) =>
        isMember(p) ? null : (
          <Button size="sm" variant="ghost" onClick={() => joinAsMaintainer(p)}>
            Join
          </Button>
        ),
    },
  ];

  return (
    <DataTable
      rows={projects}
      columns={columns}
      rowKey={(p) => p.id}
      storageKey={listPrefKey('sort', 'admin-projects')}
      defaultSort={{ key: 'updated', dir: 'desc' }}
      search={{
        placeholder: 'Search projects…',
        match: (p, q) => p.name.toLowerCase().includes(q),
      }}
      noun="project"
      empty="No projects."
      loading={loading}
    />
  );
};
