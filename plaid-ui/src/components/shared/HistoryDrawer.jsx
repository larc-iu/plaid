import { useState, useMemo, useRef, useEffect } from 'react';
import { X, History, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Badge } from '../ui/badge.jsx';
import { cn } from '../../lib/utils.js';
import { fullTimestamp } from '../../lib/formatTime.js';
import { readableDescription, operationKindLabel } from '../../lib/auditText.js';
import { Loading } from './Loading.jsx';
import { Notice } from './Notice.jsx';

// The audit log arrives already folded into logical units by the server: a
// labeled operation ("Merge morphemes"), else an atomic batch, else a lone
// write. `entry.ops` is the unit's full membership (oldest first); `time` is
// the head op's time and `endTime` the time to read at to see the whole
// operation done, which is what selecting a unit travels to.
//
// Rows size to their content (no fixed-height virtualization): a lone write
// is two short lines, a multi-op unit adds a count badge and can expand.
//
// Through `readableDescription`, as the Activity feed's rows are: a raw
// description naming two layer ids ran to three lines here and crowded out the
// entries a reader is looking for.
const unitLabel = (entry) =>
  entry.message || readableDescription(entry.ops?.[0]?.description) || 'No description';

// What kind of operation the entry is (a review, an import, the assistant),
// when it says. A neutral chip: color on a row means provenance elsewhere.
export const KindChip = ({ kind }) => {
  const label = operationKindLabel(kind);
  if (!label) return null;
  return (
    <span
      data-operation-kind={kind}
      className="mr-1.5 inline-block rounded border px-1.5 align-[1px] text-[11px] font-medium text-muted-foreground"
    >
      {label}
    </span>
  );
};

const actor = (user, apiToken) =>
  user ? ` · by ${user.displayName}${apiToken ? ` (via ${apiToken.name})` : ''}` : '';

// The panel pushes the page's content right rather than overlaying it, so the
// app that mounts it has to know how wide it is. One number, exported, rather
// than the same literal in two call sites.
export const HISTORY_DRAWER_WIDTH = 400;

// Non-modal left slide-in panel (no overlay, no focus trap) so the editor stays
// interactive while browsing history. A Radix Dialog or Sheet would trap focus.
// Opening it moves focus into its list (to Close while the list loads),
// Escape inside it closes it, and closing it gives focus back to what had it
// before, when focus was still in the drawer.
export const HistoryDrawer = ({
  isOpen,
  onClose,
  auditEntries,
  loading,
  error,
  onSelectEntry,
  selectedEntry,
  canRestore = false,
  onRestore,
}) => {
  const [expanded, setExpanded] = useState(() => new Set());

  // Most recent first
  const reversedAuditEntries = useMemo(() => [...auditEntries].reverse(), [auditEntries]);

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Selecting a unit views the document as it was AFTER the whole operation.
  // Selecting one of its member ops views the state right after that op, or
  // after its whole batch when it ran in one: a batch is atomic, so a time
  // inside it reads as before the batch, and a restore from there would undo
  // the op. The server sends that time as the op's `endTime`.
  const selectUnit = (entry) =>
    onSelectEntry({ id: entry.id, time: entry.endTime || entry.time, label: unitLabel(entry) });
  const selectOp = (op) =>
    onSelectEntry({
      id: op.id,
      time: op.endTime || op.time,
      label: readableDescription(op.description),
    });

  // The list is one tab stop (roving tabindex): the entry last focused, else
  // the selected one, else the newest. The arrow keys walk the entries and
  // the actions of an open entry, Right opens an entry and Left closes it or
  // steps from an action back to its entry, mirrored in a right-to-left page.
  const listRef = useRef(null);
  const [focusKey, setFocusKey] = useState(null);
  const unitKey = (entry) => `u:${entry.id}`;
  const opKey = (entry, op) => `o:${entry.id}:${op.id}`;
  const visibleKeys = [];
  let selectedKey = null;
  for (const entry of reversedAuditEntries) {
    visibleKeys.push(unitKey(entry));
    const ops = entry.ops || [];
    const open = ops.length > 1 && expanded.has(entry.id);
    if (entry.id === selectedEntry?.id) selectedKey = unitKey(entry);
    for (const op of ops) {
      if (op.id !== selectedEntry?.id) continue;
      selectedKey = open ? opKey(entry, op) : unitKey(entry);
    }
    if (open) [...ops].reverse().forEach((op) => visibleKeys.push(opKey(entry, op)));
  }
  const tabKey =
    [focusKey, selectedKey].find((k) => k && visibleKeys.includes(k)) ?? visibleKeys[0];

  const itemProps = (key) => ({
    type: 'button',
    'data-history-item': key,
    tabIndex: key === tabKey ? 0 : -1,
    onFocus: () => setFocusKey(key),
  });

  const focusItem = (key) =>
    listRef.current?.querySelector(`[data-history-item="${CSS.escape(key)}"]`)?.focus();

  const onListKeyDown = (e) => {
    const item = e.target.closest?.('[data-history-item]');
    if (!item) return;
    const key = item.getAttribute('data-history-item');
    const i = visibleKeys.indexOf(key);
    if (i === -1) return;
    const rtl = getComputedStyle(item).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const entryId = key.slice(2).split(':')[0];
    const entry = reversedAuditEntries.find((en) => en.id === entryId);
    const multi = (entry?.ops || []).length > 1;
    let handled = true;
    if (e.key === 'ArrowDown') focusItem(visibleKeys[Math.min(i + 1, visibleKeys.length - 1)]);
    else if (e.key === 'ArrowUp') focusItem(visibleKeys[Math.max(i - 1, 0)]);
    else if (e.key === 'Home') focusItem(visibleKeys[0]);
    else if (e.key === 'End') focusItem(visibleKeys[visibleKeys.length - 1]);
    else if (e.key === forward && key.startsWith('u:') && multi) {
      if (expanded.has(entryId)) focusItem(visibleKeys[i + 1]);
      else toggleExpanded(entryId);
    } else if (e.key === back && key.startsWith('o:')) focusItem(unitKey(entry));
    else if (e.key === back && key.startsWith('u:') && expanded.has(entryId)) {
      toggleExpanded(entryId);
    } else handled = false;
    if (handled) e.preventDefault();
  };

  // Focus on open and on close (Q1-IGT-POLISH-3).
  const rootRef = useRef(null);
  const closeRef = useRef(null);
  const listWanted = useRef(false);
  useEffect(() => {
    if (!isOpen) return undefined;
    const active = document.activeElement;
    const opener = active && active !== document.body ? active : null;
    const root = rootRef.current;
    listWanted.current = true;
    closeRef.current?.focus();
    return () => {
      listWanted.current = false;
      const now = document.activeElement;
      const lost = !now || now === document.body || root?.contains(now);
      if (lost && opener?.isConnected && !opener.disabled) opener.focus();
    };
  }, [isOpen]);
  const ready = isOpen && !loading && !error && reversedAuditEntries.length > 0;
  useEffect(() => {
    if (!ready || !listWanted.current) return;
    listWanted.current = false;
    // Unless the reader has gone elsewhere while the list loaded.
    if (document.activeElement === closeRef.current) focusItem(tabKey);
  });

  const onDrawerKeyDown = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onClose?.();
  };

  const focusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

  const renderOp = (entry, op, isLast) => {
    const isSelected = selectedEntry?.id === op.id;
    return (
      <button
        key={`${entry.id}:${op.id}`}
        {...itemProps(opKey(entry, op))}
        aria-current={isSelected ? 'true' : undefined}
        className={cn(
          'block w-full cursor-pointer border-b border-l-4 border-l-primary/30 bg-muted/20 py-2 pl-9 pr-3 text-start hover:bg-muted/50',
          focusRing,
          isLast && 'border-b',
          isSelected && 'bg-accent hover:bg-accent',
        )}
        onClick={() => selectOp(op)}
      >
        <span className="line-clamp-2 block text-sm leading-snug">
          {readableDescription(op.description)}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {fullTimestamp(op.time)}
          {actor(op.user, null)}
        </span>
      </button>
    );
  };

  const renderUnit = (entry) => {
    const ops = entry.ops || [];
    const multi = ops.length > 1;
    const isExpanded = multi && expanded.has(entry.id);
    const isSelected = selectedEntry?.id === entry.id;
    // Highlight a collapsed unit softly when it hides the selected member op.
    const containsSelected = !isExpanded && multi && ops.some((op) => op.id === selectedEntry?.id);
    const range =
      multi && entry.endTime && entry.endTime !== entry.time
        ? `${fullTimestamp(entry.time)} → ${fullTimestamp(entry.endTime)}`
        : undefined;
    return (
      <div key={entry.id}>
        {/* The row takes a click anywhere on it. The button inside is what a
            keyboard reaches, and the chevron is the mouse's way to open the
            entry (the keyboard's is ArrowRight on the button). */}
        <div
          className={cn(
            'flex cursor-pointer gap-1.5 border-b px-2 py-2.5 hover:bg-muted/50',
            isSelected && 'bg-accent hover:bg-accent',
            containsSelected && 'bg-accent/40',
          )}
          onClick={() => selectUnit(entry)}
        >
          {multi ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={isExpanded}
              className="mt-0.5 h-5 w-5 shrink-0 rounded hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(entry.id);
              }}
            >
              <ChevronRight
                className={cn(
                  'h-4 w-4 transition-transform rtl:-scale-x-100',
                  isExpanded && 'rotate-90',
                )}
              />
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <button
            {...itemProps(unitKey(entry))}
            aria-current={isSelected ? 'true' : undefined}
            aria-expanded={multi ? isExpanded : undefined}
            className={cn('min-w-0 flex-1 rounded-sm text-start', focusRing)}
            onClick={(e) => {
              e.stopPropagation();
              selectUnit(entry);
            }}
          >
            <span className="line-clamp-2 block text-sm font-medium leading-snug">
              {multi && (
                <span className="mr-1.5 inline-block rounded bg-primary/10 px-1.5 py-px align-[1px] text-[11px] font-semibold text-primary">
                  {ops.length} actions
                </span>
              )}
              <KindChip kind={entry.kind} />
              {unitLabel(entry)}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground" title={range}>
              {fullTimestamp(entry.time)}
              {actor(entry.user, entry.apiToken)}
            </span>
          </button>
        </div>
        {isExpanded &&
          [...ops].reverse().map((op, i, arr) => renderOp(entry, op, i === arr.length - 1))}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="History"
      onKeyDown={onDrawerKeyDown}
      className="fixed left-0 top-0 z-40 flex h-screen flex-col border-r bg-background shadow-lg"
      style={{ width: HISTORY_DRAWER_WIDTH }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5" />
          <span className="text-lg font-semibold">History</span>
        </div>
        <Button ref={closeRef} variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" /> Close
        </Button>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {loading && <Loading label="Loading history…" className="py-10 text-center" />}

        {error && (
          <div className="p-4">
            <Notice tone="error">
              <p className="font-medium">Failed to load the history</p>
              <p className="text-muted-foreground">{error}</p>
            </Notice>
          </div>
        )}

        {!loading && !error && reversedAuditEntries.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No entries</p>
          </div>
        )}

        {!loading && !error && reversedAuditEntries.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <p className="mb-4 text-xs text-muted-foreground">
              {reversedAuditEntries.length === 1
                ? '1 entry'
                : `${reversedAuditEntries.length.toLocaleString()} entries`}
            </p>
            <div
              ref={listRef}
              onKeyDown={onListKeyDown}
              className="min-h-0 flex-1 overflow-auto rounded-md border bg-background"
            >
              {reversedAuditEntries.map(renderUnit)}
            </div>
          </div>
        )}
      </div>

      {/* Footer with current selection info */}
      {selectedEntry && (
        <div className="border-t bg-accent p-4">
          <div className="flex flex-col items-start gap-2">
            <Badge>Historical state</Badge>
            {selectedEntry.label && (
              <p dir="auto" className="line-clamp-2 text-xs font-medium">
                {selectedEntry.label}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{fullTimestamp(selectedEntry.time)}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onSelectEntry(null)}>
                Return to current
              </Button>
              {canRestore && (
                <Button size="sm" variant="outline" onClick={() => onRestore?.(selectedEntry)}>
                  Restore
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
