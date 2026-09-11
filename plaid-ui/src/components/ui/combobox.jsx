import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn, PREFLIGHT_SCOPE } from '../../lib/utils.js';

// A text input with a list of suggestions under it, and no opinion about what
// the keys mean.
//
// That last part is why this is hand-written rather than borrowed. plaid-ud's
// annotation grid needs a picker whose keyboard contract it can share with the
// grid around it: the same arrow keys that browse the suggestion list also move
// between cells, and which of the two they mean depends on whether the list is
// open and whether an option is highlighted. A combobox that keeps that state
// to itself leaves the call site reading it back off the DOM, which is how the
// grid's arrows quietly stopped working for two months (Mantine's Autocomplete
// sets `data-expanded` and never `aria-expanded`, so the check was always
// false).
//
// So `onKeyDown(event, state)` is called with that state BEFORE this component
// acts on the key, and `event.preventDefault()` is how a call site says it took
// the key. `state` is `{ open, activeOption, activeValue, count, close }`.
//
// Options may be strings, `{value, label}`, or `{group, items}` in any mix.
// `filter({options, search})` receives them normalized and returns the same
// shape, so a call site can order matches however it likes.

const normalizeOption = (option) =>
  typeof option === 'string'
    ? { value: option, label: option }
    : { ...option, label: option.label ?? option.value };

/** Strings, `{value,label}` and `{group,items}` in, the last two out. */
export function normalizeOptions(options) {
  return (options || []).map((option) =>
    option && typeof option === 'object' && 'group' in option
      ? { ...option, items: (option.items || []).map(normalizeOption) }
      : normalizeOption(option),
  );
}

/** The options a keyboard walks, in display order, with the groups flattened away. */
export function flattenOptions(options) {
  return (options || []).flatMap((option) => ('group' in option ? option.items : [option]));
}

/** Substring match on the label, group-aware. What a call site gets if it names no filter. */
export function defaultFilter({ options, search }) {
  const q = (search || '').trim().toLowerCase();
  if (!q) return options;
  const keep = (option) => option.label.toLowerCase().includes(q);
  return options
    .map((option) => ('group' in option ? { ...option, items: option.items.filter(keep) } : option))
    .filter((option) => ('group' in option ? option.items.length > 0 : keep(option)));
}

export const Combobox = React.forwardRef(function Combobox(
  {
    value = '',
    onChange,
    options,
    filter = defaultFilter,
    renderOption,
    onSubmit,
    onKeyDown,
    onFocus,
    onBlur,
    autoHighlight = false,
    align = 'start',
    className,
    listClassName,
    optionClassName,
    groupLabelClassName,
    ...inputProps
  },
  forwardedRef,
) {
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);
  const listId = React.useId();
  const [open, setOpen] = React.useState(false);

  // Recomputed every render rather than memoized: every call site passes an
  // inline filter, so a memo would never hit, and filtering a tag set costs
  // less than the comparison that decides whether to.
  const visible = filter({ options: normalizeOptions(options), search: value ?? '' });
  const flat = flattenOptions(visible);
  const listKey = `${autoHighlight} ${flat.map((option) => option.value).join(' ')}`;

  // When the list changes under the cursor the highlight no longer means
  // anything, so it goes back to the top (or to nothing). React's documented
  // render-phase adjustment: `active` carries the new value through THIS render
  // so nothing paints the stale highlight first. The initial value is the same
  // derivation, since the first list is as much a new list as any other.
  const [activeIndex, setActiveIndex] = React.useState(() =>
    autoHighlight && flat.length ? 0 : -1,
  );
  const [lastListKey, setLastListKey] = React.useState(listKey);
  let active = activeIndex;
  if (listKey !== lastListKey) {
    active = autoHighlight && flat.length ? 0 : -1;
    setLastListKey(listKey);
    setActiveIndex(active);
  }

  const activeOption = active >= 0 ? (flat[active] ?? null) : null;
  const isOpen = open && flat.length > 0;

  const move = (delta) => {
    if (!flat.length) return;
    setActiveIndex(
      active < 0 ? (delta > 0 ? 0 : flat.length - 1) : (active + delta + flat.length) % flat.length,
    );
  };

  const submit = (option) => {
    setOpen(false);
    onSubmit?.(option.value, option);
  };

  React.useEffect(() => {
    if (!isOpen) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, active]);

  const setInputRef = (node) => {
    inputRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };

  const handleKeyDown = (event) => {
    onKeyDown?.(event, {
      open: isOpen,
      activeOption,
      activeValue: activeOption ? activeOption.value : null,
      count: flat.length,
      close: () => setOpen(false),
    });
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (isOpen) move(event.key === 'ArrowDown' ? 1 : -1);
      else setOpen(true);
    } else if (event.key === 'Enter' && activeOption) {
      event.preventDefault();
      submit(activeOption);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const renderRow = (option, index) => (
    <div
      key={`${index}-${option.value}`}
      id={`${listId}-${index}`}
      role="option"
      aria-selected={index === active}
      data-active={index === active || undefined}
      className={cn(
        'cursor-pointer whitespace-nowrap rounded-sm px-2 py-1 text-sm',
        index === active && 'bg-accent text-accent-foreground',
        optionClassName,
      )}
      // The input has to keep focus through the click, or it blurs (and
      // commits) before the click lands on anything.
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => submit(option)}
    >
      {renderOption ? renderOption({ option, active: index === active }) : option.label}
    </div>
  );

  let rowIndex = -1;

  return (
    <PopoverPrimitive.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <input
          {...inputProps}
          ref={setInputRef}
          value={value}
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-controls={isOpen ? listId : undefined}
          aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
          className={className}
          onChange={(event) => {
            setOpen(true);
            onChange?.(event.target.value, event);
          }}
          onFocus={(event) => {
            setOpen(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setOpen(false);
            onBlur?.(event);
          }}
          onKeyDown={handleKeyDown}
        />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side="bottom"
          sideOffset={2}
          // Focus stays in the input throughout: the list is something the
          // input drives, not somewhere to go.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The anchor is the input itself, which Radix counts as outside the
          // layer, so clicking an already-focused cell would otherwise close
          // its own list.
          onInteractOutside={(event) => {
            if (inputRef.current?.contains(event.target)) event.preventDefault();
          }}
          className={cn(
            PREFLIGHT_SCOPE,
            'z-50 max-h-60 w-max overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            listClassName,
          )}
          // As wide as its content, but never narrower than the field: an
          // annotation cell can be four characters wide and its tags are not.
          style={{ minWidth: 'var(--radix-popover-trigger-width)' }}
        >
          <div ref={listRef} id={listId} role="listbox">
            {visible.map((entry, groupIndex) =>
              'group' in entry ? (
                <div
                  key={`group-${groupIndex}-${entry.group}`}
                  role="group"
                  aria-label={entry.group}
                >
                  <div
                    className={cn(
                      'px-2 py-1 text-xs font-medium text-muted-foreground',
                      groupLabelClassName,
                    )}
                  >
                    {entry.group}
                  </div>
                  {entry.items.map((option) => renderRow(option, ++rowIndex))}
                </div>
              ) : (
                renderRow(entry, ++rowIndex)
              ),
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
});
