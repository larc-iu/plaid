import { Link, useLocation, useNavigate } from 'react-router-dom';
import { EntityAvatar } from '../common/EntityAvatar.jsx';
import { Tabs, TabsList, TabsTrigger } from '@ui/components/ui/tabs';

export const DocumentTabs = ({ projectId, documentId, project, document, disabled = false }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname;
  const active = currentPath.includes('/annotate')
    ? 'annotate'
    : currentPath.includes('/export')
      ? 'export'
      : currentPath.includes('/details')
        ? 'details'
        : 'edit';
  const base = `/projects/${projectId}/documents/${documentId}`;

  const routes = {
    edit: `${base}/edit`,
    annotate: `${base}/annotate`,
    export: `${base}/export`,
    details: `${base}/details`,
  };

  // A tab is a real anchor, so middle-click and cmd-click open it in a new
  // browser tab. While the body is busy (reconcile-on-open is repairing the
  // document) it becomes a plain disabled button instead: an anchor cannot be
  // stopped from navigating, and a tab switch mid-repair would drop the user
  // into the Text Editor to re-tokenize a document whose heal writes are still
  // in flight, which is the thing the spinner exists to prevent. Dropping `to`
  // gives a real disabled trigger, so click, cmd-click and keyboard activation
  // are all inert.
  const target = (value) => (disabled ? { disabled: true } : { to: routes[value] });

  return (
    <div className="tw mb-6">
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-sm">
        <Link to="/projects" className="text-muted-foreground hover:text-foreground">
          Projects
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link
          to={`/projects/${projectId}/documents`}
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <EntityAvatar id={projectId} size={16} />
          <span className="truncate">{project?.name || 'Loading…'}</span>
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <EntityAvatar id={documentId} size={16} />
          <span className="truncate text-muted-foreground">{document?.name || 'Loading…'}</span>
        </span>
      </nav>

      <Tabs value={active} onValueChange={(v) => !disabled && navigate(routes[v])}>
        <TabsList>
          <TabsTrigger value="edit" {...target('edit')}>
            Text Editor
          </TabsTrigger>
          <TabsTrigger value="annotate" {...target('annotate')}>
            Annotate
          </TabsTrigger>
          <TabsTrigger value="export" {...target('export')}>
            Export
          </TabsTrigger>
          <TabsTrigger value="details" {...target('details')}>
            Details
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
};
