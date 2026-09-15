import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils.js';
import { flattenOptions } from '../shared/comboboxOptions.js';

// What `@` offers, over the composer it is being typed into.
//
// Anchored to the composer box and opening UPWARD, not floating at the caret.
// A caret-anchored list means measuring a character position inside a textarea,
// which cannot be done without a mirror element and breaks on wrap, on resize
// and on every font the reader might have. The composer is a few lines tall and
// the panel is narrow, so a list above it is never far from the caret anyway.
//
// It draws nothing and takes no keys: the composer owns the highlight and the
// keyboard, because it is the composer's Enter that has to be arbitrated.
export const MentionList = ({ groups, activeId, onPick, onHover, loading }) => {
  const ref = useRef(null);

  // Keep the highlighted row in view when the arrows walk past the edge.
  useEffect(() => {
    const el = ref.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const items = flattenOptions(groups);
  if (loading && !items.length)
    return (
      <div className="absolute inset-x-0 bottom-full z-20 mb-1 rounded-lg border bg-popover p-2 text-xs text-muted-foreground shadow-md">
        Looking…
      </div>
    );
  // Nothing matched: the list closes rather than saying so. `@` is a typeahead
  // over what is already on screen, and a box announcing "no matches" after
  // every letter that does not match is in the way of the typing.
  if (!items.length) return null;

  return (
    <div
      ref={ref}
      className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
    >
      {groups.map((group) =>
        'group' in group ? (
          <div key={group.group}>
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {group.group}
            </div>
            {group.items.map((item) => (
              <Row
                key={item.id}
                item={item}
                active={item.id === activeId}
                onPick={onPick}
                onHover={onHover}
              />
            ))}
          </div>
        ) : (
          <Row
            key={group.id}
            item={group}
            active={group.id === activeId}
            onPick={onPick}
            onHover={onHover}
          />
        ),
      )}
    </div>
  );
};

// `onMouseDown` with the default prevented, not `onClick`: a click would blur
// the composer first, and a blur that closed the list would take the row out
// from under the pointer before the click landed.
const Row = ({ item, active, onPick, onHover }) => (
  <button
    type="button"
    data-active={active ? 'true' : 'false'}
    onMouseDown={(e) => {
      e.preventDefault();
      onPick(item);
    }}
    onMouseEnter={() => onHover(item.id)}
    className={cn(
      'flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm',
      active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
    )}
  >
    <span className="shrink-0 font-medium">{item.label}</span>
    {item.hint && (
      <span dir="auto" className="truncate text-xs text-muted-foreground">
        {item.hint}
      </span>
    )}
  </button>
);
