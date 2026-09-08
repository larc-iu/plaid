import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { FormLabel } from './FormLabel';

// Find one entry of a vocabulary by typing part of its form or gloss, and
// pick it. Used wherever an entry is chosen as a value: a reference field,
// the parent of a sense. Every entry is already in memory, so the list is a
// local filter; nothing is fetched.
//
// The entries are shown form first with the dotted number, then the
// gloss, so two entries with one form can be told apart before picking.

const LIMIT = 30;

/**
 * @param {object[]} items every entry of the vocabulary, in creation order
 * @param {Map} numbers id -> its dotted number (buildItemNumbers)
 * @param {Set<string>} [exclude] ids never offered (the entry itself, say)
 * @param {(id: string) => void} onPick
 */
export const ItemPicker = ({
  items,
  numbers,
  exclude,
  onPick,
  placeholder = 'Type a form or gloss…',
  autoFocus = false,
  disabled = false,
  id,
  className,
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const starts = [];
    const rest = [];
    for (const it of items || []) {
      if (exclude?.has(it.id)) continue;
      const form = (it.form ?? '').toLowerCase();
      const gloss = String(it.metadata?.gloss ?? '').toLowerCase();
      if (form.startsWith(q)) starts.push(it);
      else if (form.includes(q) || gloss.includes(q)) rest.push(it);
      if (starts.length >= LIMIT) break;
    }
    return [...starts, ...rest].slice(0, LIMIT);
  }, [items, exclude, query]);

  const pick = (it) => {
    onPick(it.id);
    setQuery('');
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e) => {
    if (!open || !matches.length) {
      if (e.key === 'Escape') setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[active]) pick(matches[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          compose
          id={id}
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-autocomplete="list"
          className={cn('h-8', className)}
          placeholder={placeholder}
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="max-h-72 w-[var(--radix-popover-trigger-width)] min-w-64 overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // Clicking back into the input is not leaving.
          if (e.target?.id && e.target.id === id) e.preventDefault();
        }}
      >
        <ul role="listbox">
          {matches.map((it, i) => (
            <li
              key={it.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the input
                pick(it);
              }}
              className={cn(
                'flex cursor-pointer items-baseline gap-2 rounded px-2 py-1 text-sm',
                i === active && 'bg-accent',
              )}
            >
              <FormLabel form={it.form} index={numbers?.get(it.id)} className="font-medium" />
              {it.metadata?.gloss && (
                <span className="truncate text-xs text-muted-foreground">
                  {String(it.metadata.gloss)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
};
