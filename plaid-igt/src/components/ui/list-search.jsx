import * as React from 'react';
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Search as SearchIcon,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// The chrome every browsable list in the app wears: one search box, one count,
// one pager. Kept together so that a list of documents, of lexicon entries and
// of tagset values are told apart by their rows and by nothing else.

// A search box with its magnifier and a clear button. `onChange` takes the
// string, not the event, because no call site wanted the event.
export const SearchInput = React.forwardRef(
  ({ value, onChange, placeholder = 'Search…', className, inputClassName, ...props }, ref) => (
    <div className={cn('relative', className)}>
      <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        // A search box is not prose, and half of what is typed into these is a
        // form in the language being documented.
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('pl-7 pr-7', inputClassName)}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  ),
);
SearchInput.displayName = 'SearchInput';

const plural = (n, noun) => (n === 1 ? noun : `${noun}s`);

// How much of the list a search is hiding. Sits beside the search box.
export const ListCount = ({ shown, total, noun = 'item', className }) => (
  <span className={cn('whitespace-nowrap text-xs text-muted-foreground', className)}>
    {shown === total
      ? `${total.toLocaleString()} ${plural(total, noun)}`
      : `${shown.toLocaleString()} of ${total.toLocaleString()} ${plural(total, noun)}`}
  </span>
);

// A note under a list: what a capped search left out, and how to see it.
export const ListHint = ({ children, className }) => (
  <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>
);

const PagerButton = ({ icon, label, ...props }) => {
  // Uppercase local, the way SortHeader does it: this config drops
  // eslint-plugin-react, so a component used only in JSX has to look like a
  // component to no-unused-vars.
  const Icon = icon;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
};

// The pager strip, which belongs inside the list's own border. A paged list
// carries one above the rows and one below, so that turning the page never
// means scrolling to the end to find the control. Takes the shape
// `pageSlice`/`usePagedList` return, so a call site spreads it:
//   <ListPager {...paged} onPage={paged.setPage} position="top" />
// Renders nothing when everything already fits on one page.
export const ListPager = ({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPage,
  position = 'bottom',
  className,
}) => {
  if (pageCount <= 1) return null;
  const atStart = page === 0;
  const atEnd = page >= pageCount - 1;
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-1 px-2 py-1.5 text-xs text-muted-foreground',
        position === 'top' ? 'border-b' : 'border-t',
        className,
      )}
    >
      <div className="flex items-center">
        <PagerButton
          icon={ChevronFirst}
          label="First page"
          disabled={atStart}
          onClick={() => onPage(0)}
        />
        <PagerButton
          icon={ChevronLeft}
          label="Previous page"
          disabled={atStart}
          onClick={() => onPage(page - 1)}
        />
      </div>
      <span className="tabular-nums">
        {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center">
        <PagerButton
          icon={ChevronRight}
          label="Next page"
          disabled={atEnd}
          onClick={() => onPage(page + 1)}
        />
        <PagerButton
          icon={ChevronLast}
          label="Last page"
          disabled={atEnd}
          onClick={() => onPage(pageCount - 1)}
        />
      </div>
    </div>
  );
};
