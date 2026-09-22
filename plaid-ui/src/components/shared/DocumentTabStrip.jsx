import { Link, useLocation, useNavigate } from 'react-router-dom';
import { appRoutes } from '../../lib/uiConfig.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { useUnsavedGuard } from '../../hooks/useUnsavedDraft.js';

/**
 * The breadcrumb and tab row over an open document.
 *
 * `tabs` is the app's, as data (`{ value, label, to }`), because which tabs a
 * document has is the app's: plaid-ud edits the text under its annotation and
 * plaid-umr does not, plaid-umr compares two graphs and plaid-ud does not. The
 * first tab is what an unrecognised path falls back to.
 *
 * `disabled` makes every tab a plain disabled button instead of an anchor:
 * while the body is busy (reconcile-on-open repairing the document) an anchor
 * cannot be stopped from navigating, and a tab switch mid-repair leaves the
 * repair writing under a screen that has moved on, which is the thing the
 * spinner exists to prevent. Dropping `to` gives a real disabled trigger, so
 * click, cmd-click and keyboard activation are all inert.
 */
export const DocumentTabStrip = ({ projectId, project, document, tabs, disabled = false }) => {
  const location = useLocation();
  const navigate = useNavigate();
  // A tab that holds something typed and unsaved is asked about before the
  // strip leaves it.
  const guard = useUnsavedGuard();
  const routes = appRoutes();

  const p = location.pathname;
  const active = tabs.find((t) => p.includes(`/${t.value}`))?.value ?? tabs[0].value;
  const to = Object.fromEntries(tabs.map((t) => [t.value, t.to]));
  const target = (value) => (disabled ? { disabled: true } : { to: to[value] });

  return (
    <div className="mb-6">
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-sm">
        <Link to={routes.projects} className="text-muted-foreground hover:text-foreground">
          Projects
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link
          to={routes.documents(projectId)}
          className="min-w-0 truncate text-muted-foreground hover:text-foreground"
        >
          {project?.name || 'Loading…'}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span dir="auto" className="truncate text-muted-foreground">
          {document?.name || 'Loading…'}
        </span>
      </nav>

      <Tabs value={active} onValueChange={(v) => !disabled && navigate(to[v])} guard={guard}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} {...target(t.value)}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
};
