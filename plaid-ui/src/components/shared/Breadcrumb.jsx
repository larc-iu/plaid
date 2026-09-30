import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils.js';

/**
 * The way back from a page, one look in every app: the places above it, each
 * a grey link, each followed by a slash. The page itself is not in the trail,
 * since its heading names it right below: a trail ending in the page's own
 * name showed that name twice.
 *
 * Props:
 * - `items`: `[{ label, to }]`, outermost first. Each is a real anchor, so
 *   middle-click opens it in a new tab, and it underlines on hover. An item
 *   without `to` (a name still loading) is plain grey text.
 * - `fixed: true` on an item whose label is the app's own words ("Projects",
 *   "New project"). It never shrinks. Every other label is data (a project
 *   name in any script) and truncates when the row runs out of room, so a
 *   long name gives way before the way back does. A data label counts as no
 *   width when the row decides whether to wrap, so only fixed labels that
 *   cannot all fit on a phone take a second line.
 * - `className`: added to the `<nav>`, for the margin the page wants.
 *
 * Every item carries `dir="auto"`, since a label is so often data. The trail
 * itself stays left to right like the rest of the chrome.
 */
export const Breadcrumb = ({ items, className }) => (
  <nav aria-label="Breadcrumb" className={cn('min-w-0 text-sm', className)}>
    <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {items.map((item, i) => (
        <Fragment key={i}>
          <li
            className={
              item.fixed ? 'shrink-0 whitespace-nowrap' : 'min-w-0 max-w-fit flex-1 truncate'
            }
          >
            {item.to ? (
              <Link
                to={item.to}
                dir="auto"
                className="text-muted-foreground hover:text-foreground hover:underline"
              >
                {item.label}
              </Link>
            ) : (
              <span dir="auto" className="text-muted-foreground">
                {item.label}
              </span>
            )}
          </li>
          <li aria-hidden="true" className="shrink-0 text-muted-foreground/60">
            /
          </li>
        </Fragment>
      ))}
    </ol>
  </nav>
);
