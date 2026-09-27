import { useLocation, useNavigate } from 'react-router-dom';
import { appRoutes } from '../../lib/uiConfig.js';
import { cn } from '../../lib/utils.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Breadcrumb } from './Breadcrumb.jsx';
import { useUnsavedGuard } from '../../hooks/useUnsavedDraft.js';

/**
 * The header over an open document, in every app: the breadcrumb, a heading
 * naming the document, and the tab row.
 *
 * `tabs` is the app's, as data (`{ value, label, to, count }`), because which
 * tabs a document has is the app's: plaid-ud edits the text under its
 * annotation and plaid-umr does not, plaid-umr compares two graphs and plaid-ud
 * does not. The order every app keeps is its own work tabs first, then
 * Comments, Export, Details. `count` is drawn as a small number beside the
 * label when above zero (the Comments tab's threads).
 *
 * `active` is the tab showing. Left out, it is read off the path, where the
 * app keeps one route per tab (ud, umr), and the first tab is what an
 * unrecognised path falls back to. plaid-igt keeps its tab in `?tab=` and says.
 *
 * `disabled` makes every tab a plain disabled button instead of an anchor:
 * while the body is busy (reconcile-on-open repairing the document) an anchor
 * cannot be stopped from navigating, and a tab switch mid-repair leaves the
 * repair writing under a screen that has moved on. Dropping `to` gives a real
 * disabled trigger, so click, cmd-click and keyboard activation are all inert.
 *
 * `status` is drawn at the end of the breadcrumb row: the document's save
 * status (SaveStatus). `actions` is drawn at the end of the tab row: History,
 * which is about the document on every tab rather than about one of them.
 *
 * `sticky` pins the tab row under the app header while the page scrolls. The
 * header's height, where it is itself pinned, comes from `--plaid-sticky-top`
 * on an ancestor. The strip then lays its three parts out in its parent's box,
 * so the row stays pinned for as long as that box is on screen.
 */
export const DocumentTabStrip = ({
  projectId,
  project,
  document,
  tabs,
  active: activeProp = null,
  disabled = false,
  status = null,
  actions = null,
  sticky = false,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  // A tab that holds something typed and unsaved is asked about before the
  // strip leaves it.
  const guard = useUnsavedGuard();
  const routes = appRoutes();

  const p = location.pathname;
  const active = activeProp ?? tabs.find((t) => p.includes(`/${t.value}`))?.value ?? tabs[0].value;
  const to = Object.fromEntries(tabs.map((t) => [t.value, t.to]));
  const target = (value) => (disabled ? { disabled: true } : { to: to[value] });
  const name = document?.name;

  return (
    <div className={sticky ? 'contents' : 'mb-6'}>
      <div className="mb-2 flex items-center gap-2">
        <Breadcrumb
          items={[
            { label: 'Projects', to: routes.projects },
            { label: project?.name || 'Loading…', to: routes.documents(projectId) },
            { label: name || 'Loading…' },
          ]}
        />
        {status && <span className="ms-auto shrink-0">{status}</span>}
      </div>

      <h1
        dir="auto"
        className={cn(
          'mb-3 break-words text-3xl font-bold tracking-tight',
          !name && 'text-muted-foreground',
        )}
      >
        {name || 'Loading…'}
      </h1>

      <div
        data-testid="document-tab-row"
        className={cn(
          'flex flex-wrap items-center gap-x-6 gap-y-2',
          sticky &&
            'sticky top-[var(--plaid-sticky-top,0px)] z-30 mb-4 border-b bg-background/95 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80',
        )}
      >
        <Tabs
          value={active}
          onValueChange={(v) => !disabled && navigate(to[v])}
          guard={guard}
          className="min-w-0"
        >
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} {...target(t.value)}>
                {t.label}
                {t.count > 0 && (
                  <span className="ms-1.5 rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                    {t.count}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {actions && <div className="ms-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
};
