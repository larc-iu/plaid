import { Link, useLocation, useNavigate } from 'react-router-dom';
import { isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject } from '../../domain/permissions.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { useAssistantSubject } from '../assistant/subject.js';

/**
 * The breadcrumb and tab row every project-level screen wears, mirroring the
 * per-document tabs. Each tab is route-backed and renders no panel: the route
 * renders its own body.
 *
 * `tabs` is the app's, as data: `{ value, label, to }`, plus `show` for one
 * that is not always offered, `alsoWhenActive` for one whose route works even
 * then, and `match` where the tab stands for several paths. The strip decides
 * which is active and draws them; which tabs a project has is the app's.
 *
 * It is also where the shell's assistant panel learns which project the reader
 * is on. Every project-level screen renders this strip and is already handed
 * the project, so this is the ONE place that fact exists for all of them: the
 * alternative was the same five-line hook call repeated in seven screens, each
 * of which would then have to remember it. A document has a subject of its own
 * (its editor shell publishes it) and does not render this.
 */
export const ProjectTabStrip = ({ projectId, project, tabs, defaultValue = tabs[0]?.value }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  // The panel is about the PROJECT here. No subject of its own: what a reader
  // is looking at on these screens is the project at large, and naming a screen
  // the assistant has no tool for (the importer, the access list) would invite
  // it to claim it can act there.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    canWrite: canEditProject(project, user),
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
  });

  const p = location.pathname;
  const active =
    tabs.find((t) => (t.match ? t.match.test(p) : p.endsWith(`/${t.value}`)))?.value ??
    defaultValue;
  const shown = tabs.filter((t) => t.show !== false || (t.alsoWhenActive && active === t.value));
  const to = Object.fromEntries(tabs.map((t) => [t.value, t.to]));

  return (
    <div className="mb-6">
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-sm">
        <Link to={appRoutes().projects} className="text-muted-foreground hover:text-foreground">
          Projects
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="truncate text-muted-foreground">{project?.name || 'Loading…'}</span>
      </nav>

      {/* Every tab is a real anchor (`to`), so middle-click and cmd-click open
          it in a new browser tab; a plain click is Radix's, and this navigates
          on its behalf. The shared trigger already swallows Radix's double
          fire. */}
      <Tabs value={active} onValueChange={(v) => navigate(to[v])}>
        <TabsList>
          {shown.map((t) => (
            <TabsTrigger key={t.value} value={t.value} to={t.to}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
};
