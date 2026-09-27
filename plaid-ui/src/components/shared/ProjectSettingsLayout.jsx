import { Link } from 'react-router-dom';
import { FORM_PAGE_WIDTH } from '../../lib/pageWidth.js';
import { cn } from '../../lib/utils.js';

/**
 * A project's settings as one layout in every app: a list of links down the
 * left and the active section beside it, at the width of a form.
 *
 * Props:
 * - `sections`: the app's, as data, `[{ value, label, body }]`, in the order
 *   they are listed. General comes first in every app: it is where a
 *   maintainer goes most, and it holds the delete.
 * - `active`: the section shown, one of `sections`.
 * - `href(value)`: the URL of a section. Each section IS a page with its own
 *   URL, so the list is a list of links rather than a tab widget, and
 *   middle-click opens a section in a new tab.
 * - `bodyProps`: what `active.body(bodyProps)` is called with.
 *
 * A section draws its own cards, one per part, since a section such as
 * Access has several parts with a heading each. The list carries no icons.
 * The list is chrome and stays left to right, and nothing here is inset
 * physically, so it needs no `dir`.
 */
export const ProjectSettingsLayout = ({ sections, active, href, bodyProps }) => (
  <div className={cn('flex flex-col gap-6 sm:flex-row sm:items-start', FORM_PAGE_WIDTH)}>
    <nav aria-label="Settings" className="flex shrink-0 flex-col gap-1 sm:w-52">
      {sections.map(({ value, label }) => (
        <Link
          key={value}
          to={href(value)}
          aria-current={value === active.value ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-2 text-sm font-medium transition-colors',
            value === active.value
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>

    <div className="flex min-w-0 flex-1 flex-col gap-6">{active.body(bodyProps)}</div>
  </div>
);
