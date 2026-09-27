import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils.js';

/**
 * The trail of links at the top of a page, one look in every app.
 *
 * Props:
 * - `items`: `[{ label, to }]`, outermost first. Every item but the last is a
 *   grey link (a real anchor, so middle-click opens it in a new tab) that
 *   underlines on hover. The LAST item is the current page: dark, not a link,
 *   `aria-current="page"`, whatever `to` it carries.
 * - `className`: added to the `<nav>`, for the margin the page wants.
 *
 * A label is often data (a project or document name in any script), so every
 * item carries `dir="auto"`, and a long one truncates rather than wrapping.
 * The trail itself stays left to right like the rest of the chrome.
 */
export const Breadcrumb = ({ items, className }) => (
  <nav aria-label="Breadcrumb" className={cn('min-w-0 text-sm', className)}>
    <ol className="flex min-w-0 items-center gap-2">
      {items.map((item, i) => {
        const current = i === items.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && (
              <li aria-hidden="true" className="shrink-0 text-muted-foreground">
                /
              </li>
            )}
            <li className="min-w-0 truncate">
              {current ? (
                <span dir="auto" aria-current="page" className="text-foreground">
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to}
                  dir="auto"
                  className="text-muted-foreground hover:text-foreground hover:underline"
                >
                  {item.label}
                </Link>
              )}
            </li>
          </Fragment>
        );
      })}
    </ol>
  </nav>
);
