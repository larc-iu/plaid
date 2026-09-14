import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { isUdProject } from '@ui/domain/udProject';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { findBaselineTextLayer, readInitialized } from '../../domain/igtConfig';
import { udProjectUrl } from '@ui/domain/siblingApps.js';
import { textIncludes } from '@ui/domain/collation.js';
import { projectRole } from '@larc-iu/plaid-client';

// Every project on the server, including the ones this admin has no role in.
// An admin's project list already returns all of them; what is missing
// everywhere else is who is on each, which app owns it, and whether anyone has
// touched it lately.

// Which app owns the project. This one knows its own for certain, from its own
// config module, and knows plaid-ud's from the shared package: a shape one app
// has to recognise in ANOTHER app's project is what plaid-ui is for, and a
// second copy of that answer living here is how two apps start disagreeing
// about what a project is.
const shapeOf = (project) => {
  if (readInitialized(project.config)) return 'IGT';
  if (isUdProject(project)) return 'UD';
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

  // Explicit membership, not what an admin may do: the offer below is "add me
  // to this project", and every project on this screen is one an admin reaches.
  const isMember = (p) => projectRole(p, currentUser?.id) !== null;

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sort: (p) => p.name.toLowerCase(),
      // A project's name is its way in, and a UD project's way in is the UD
      // app: this one sends a project it did not set up to its setup wizard,
      // which is the wrong thing to do to someone else's corpus. That is a
      // full page load, so a plain anchor, not a router Link.
      render: (p) =>
        isUdProject(p) ? (
          <a href={udProjectUrl(p.id)} className="font-medium hover:underline">
            {p.name}
          </a>
        ) : (
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
      id="admin-projects"
      defaultSort={{ key: 'updated', dir: 'desc' }}
      search={{
        placeholder: 'Search projects…',
        match: (p, q) => textIncludes(p.name, q),
      }}
      noun="project"
      empty="No projects."
      loading={loading}
    />
  );
};
