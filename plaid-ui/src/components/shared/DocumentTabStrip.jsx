import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { appRoutes } from '../../lib/uiConfig.js';
import { cn } from '../../lib/utils.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Breadcrumb } from './Breadcrumb.jsx';
import { ProjectTartan } from './ProjectTartan.jsx';
import { useUnsavedGuard } from '../../hooks/useUnsavedDraft.js';
import { useProjectFavicon } from '../../hooks/useProjectFavicon.js';

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
 * `sticky` pins the tab row under the app header while the page scrolls, in
 * every app. The header's height comes from `--plaid-sticky-top` (plaid-ui's
 * index.css sets it on the root). The strip then lays its three parts out in
 * its parent's box, so the row stays pinned for as long as that box is on
 * screen: the parent should be the whole page, not a wrapper around the strip.
 * `inset` is the horizontal padding each part takes in that box, for a page
 * whose body runs to the window's edge (plaid-ud's and plaid-umr's grids).
 *
 * Once the page has scrolled the breadcrumb and heading out of sight, the
 * pinned row starts with the project's name (and tartan, where the project
 * shows one), a link back to the project, so leaving a long document does not
 * mean scrolling back to its top.
 *
 * While pinned, the row's height is measured into `--plaid-tab-row-height` on
 * the root, where index.css adds it to the page's scroll padding, so a row
 * scrolled to the top of the window lands below the tabs. Measured, because on
 * a phone the tabs and History wrap to a second line.
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
  inset = '',
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  // A tab that holds something typed and unsaved is asked about before the
  // strip leaves it.
  const guard = useUnsavedGuard();
  const routes = appRoutes();
  const rowRef = useRef(null);
  const headingRef = useRef(null);
  // The heading has gone up behind the pinned row, and the breadcrumb with it.
  const [scrolledPast, setScrolledPast] = useState(false);
  useProjectFavicon(project);

  useLayoutEffect(() => {
    if (!sticky) return undefined;
    let frame = 0;
    const check = () => {
      frame = 0;
      const heading = headingRef.current;
      const row = rowRef.current;
      if (!heading || !row) return;
      setScrolledPast(heading.getBoundingClientRect().bottom <= row.getBoundingClientRect().top);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sticky]);

  // `document` here is the Plaid document, so the page is `window.document`.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!sticky || !row || typeof ResizeObserver === 'undefined') return undefined;
    const root = window.document.documentElement;
    const measure = () => root.style.setProperty('--plaid-tab-row-height', `${row.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--plaid-tab-row-height');
    };
  }, [sticky]);

  const p = location.pathname;
  const active = activeProp ?? tabs.find((t) => p.includes(`/${t.value}`))?.value ?? tabs[0].value;
  const to = Object.fromEntries(tabs.map((t) => [t.value, t.to]));
  const target = (value) => (disabled ? { disabled: true } : { to: to[value] });
  const name = document?.name;

  return (
    <div className={sticky ? 'contents' : 'mb-6'}>
      <div className={cn('mb-2 flex items-center gap-2', inset)}>
        <Breadcrumb
          items={[
            { label: 'Projects', to: routes.projects, fixed: true },
            {
              label: project?.name || 'Loading…',
              to: routes.documents(projectId),
              icon: <ProjectTartan project={project} size={14} />,
            },
          ]}
        />
        {status && <span className="ms-auto shrink-0">{status}</span>}
      </div>

      {/* The name takes its own direction inside a heading that stays with the
          chrome, so an Arabic name reads right to left and still starts at the
          left edge under the breadcrumb. */}
      <h1
        ref={headingRef}
        className={cn(
          'mb-2 break-words font-text text-[1.75rem] font-bold leading-tight',
          !name && 'text-muted-foreground',
          inset,
        )}
      >
        <span dir="auto">{name || 'Loading…'}</span>
      </h1>

      <div
        ref={rowRef}
        data-testid="document-tab-row"
        data-pinned={sticky || undefined}
        className={cn(
          'flex flex-wrap items-center gap-x-6 gap-y-2',
          sticky &&
            'sticky top-[var(--plaid-sticky-top,0px)] z-30 mb-2 border-b bg-background/95 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/80',
          inset,
        )}
      >
        {sticky && scrolledPast && (
          <Link
            to={routes.documents(projectId)}
            dir="auto"
            data-testid="tab-row-project"
            className="-me-3 flex min-w-0 max-w-[16rem] shrink items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <ProjectTartan project={project} size={14} className="shrink-0" />
            <span className="truncate">{project?.name || 'Project'}</span>
          </Link>
        )}
        <Tabs
          value={active}
          onValueChange={(v) => !disabled && navigate(to[v])}
          guard={guard}
          className="min-w-0"
        >
          {/* Pinned, the row's own rule is the tabs' rule: a second one under
              the list drew two lines a few pixels apart. */}
          <TabsList className={sticky ? 'border-b-0' : undefined}>
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
