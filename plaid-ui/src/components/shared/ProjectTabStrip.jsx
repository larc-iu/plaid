import { useLocation, useNavigate } from 'react-router-dom';
import { isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject } from '../../domain/permissions.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Breadcrumb } from './Breadcrumb.jsx';
import { useAssistantSubject } from '../assistant/subject.js';
import { useUnsavedGuard } from '../../hooks/useUnsavedDraft.js';

/**
 * The breadcrumb and tab row every project-level screen wears, mirroring the
 * per-document tabs. Each tab is route-backed and renders no panel: the route
 * renders its own body.
 *
 * `tabs` is the app's, as data: `{ value, label, to }`, plus `show` for one
 * that is not always offered (drawn only when it is `true`), `alsoWhenActive` for one whose route works even
 * then, and `match` where the tab stands for several paths. The strip decides
 * which is active and draws them; which tabs a project has is the app's.
 *
 * `active` is for an app that keeps the tab somewhere a path does not show
 * (plaid-igt's `?tab=`): it names the active tab outright, and `match` and
 * the path are not consulted.
 *
 * Above the tabs, the breadcrumb and a heading naming the project, so a reader
 * who lands from a link is told where they are in more than a small trail.
 *
 * It is also where the shell's assistant panel learns which project the reader
 * is on. Every project-level screen renders this strip and is already handed
 * the project, so this is the ONE place that fact exists for all of them: the
 * alternative was the same five-line hook call repeated in seven screens, each
 * of which would then have to remember it. A document has a subject of its own
 * (its editor shell publishes it) and does not render this.
 */
export const ProjectTabStrip = ({
  projectId,
  project,
  tabs,
  active: activeValue,
  defaultValue = tabs[0]?.value,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  // A screen under these tabs may hold typed text (a guideline being written),
  // and a tab is a way out of it like any link.
  const guard = useUnsavedGuard();

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
    activeValue ??
    tabs.find((t) => (t.match ? t.match.test(p) : p.endsWith(`/${t.value}`)))?.value ??
    defaultValue;
  // A tab that carries `show` is offered only once it is TRUE: null is "not
  // known yet" (whether an assistant is online, say), and drawing the tab and
  // then withdrawing it is a flicker, or a tab that opens onto nothing.
  const shown = tabs.filter(
    (t) => !('show' in t) || t.show === true || (t.alsoWhenActive && active === t.value),
  );
  const to = Object.fromEntries(tabs.map((t) => [t.value, t.to]));

  return (
    <div className="mb-6">
      <Breadcrumb
        className="mb-2"
        items={[
          { label: 'Projects', to: appRoutes().projects, fixed: true },
          { label: project?.name || 'Loading…' },
        ]}
      />
      {/* The name is data in any script, so it takes its own direction inside
          a heading that stays with the chrome: an Arabic name reads right to
          left and still starts at the left edge under the breadcrumb. The
          minimum height holds the tabs still while the project loads. */}
      <h1 className="mb-3 min-h-9 truncate font-text text-[1.75rem] font-bold leading-tight">
        <span dir="auto">{project?.name}</span>
      </h1>

      {/* Every tab is a real anchor (`to`), so middle-click and cmd-click open
          it in a new browser tab; a plain click is Radix's, and this navigates
          on its behalf. The shared trigger already swallows Radix's double
          fire. */}
      <Tabs value={active} onValueChange={(v) => navigate(to[v])} guard={guard}>
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
