import { useState, useRef, useMemo } from 'react';
import { X, History, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const ITEM_HEIGHT = 120; // Height of each row in pixels
const BUFFER_SIZE = 5; // Number of rows to render outside visible area

// The audit log arrives already folded into logical units by the server: a
// labeled operation ("Merge morphemes"), else an atomic batch, else a lone
// write. `entry.ops` is the unit's full membership (oldest first); `time` is
// the head op's time and `endTime` the last member's — the state AFTER the
// whole operation, which is what selecting a unit travels to.
const unitLabel = (entry) =>
  entry.message || entry.ops?.[0]?.description || 'No description available';

const formatTime = (timestamp) => new Date(timestamp).toLocaleString();

const actorLine = (user, apiToken) =>
  user ? `by ${user.username}${apiToken ? ` (via ${apiToken.name})` : ''}` : null;

// Non-modal left slide-in panel (no overlay, no focus trap) so the editor stays
// interactive while browsing history — preserves the old Mantine Drawer's
// withOverlay={false} behavior. A radix Dialog/Sheet would wrongly trap focus.
export const HistoryDrawer = ({
  isOpen,
  onClose,
  auditEntries,
  loading,
  error,
  onSelectEntry,
  selectedEntry,
}) => {
  const [scrollTop, setScrollTop] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set());
  const scrollContainerRef = useRef(null);

  // Most recent first
  const reversedAuditEntries = useMemo(() => [...auditEntries].reverse(), [auditEntries]);

  // Flatten units into a uniform-height row list so the virtual scroller keeps
  // working. A unit is one row; expanding a multi-op unit splices its member
  // ops (newest first, matching the list direction) in directly below it.
  const rows = useMemo(() => {
    const out = [];
    for (const entry of reversedAuditEntries) {
      const ops = entry.ops || [];
      const multi = ops.length > 1;
      const isExpanded = multi && expanded.has(entry.id);
      out.push({ key: entry.id, type: 'unit', entry, multi, expanded: isExpanded });
      if (isExpanded) {
        const children = [...ops].reverse();
        children.forEach((op, i) =>
          out.push({
            key: `${entry.id}:${op.id}`,
            type: 'op',
            entry,
            op,
            isLast: i === children.length - 1,
          }),
        );
      }
    }
    return out;
  }, [reversedAuditEntries, expanded]);

  const visibleRange = useMemo(() => {
    const actualHeight = scrollContainerRef.current?.clientHeight || 400;
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
    const endIndex = Math.min(
      rows.length - 1,
      Math.ceil((scrollTop + actualHeight) / ITEM_HEIGHT) + BUFFER_SIZE,
    );
    return { startIndex, endIndex };
  }, [scrollTop, rows.length]);

  const handleScroll = (e) => setScrollTop(e.target.scrollTop);

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Selecting a unit views the document as it was AFTER the whole operation;
  // selecting one of its member ops views the state right after that op.
  const selectUnit = (entry) =>
    onSelectEntry({ id: entry.id, time: entry.endTime || entry.time, label: unitLabel(entry) });
  const selectOp = (op) => onSelectEntry({ id: op.id, time: op.time, label: op.description });

  const totalHeight = rows.length * ITEM_HEIGHT;
  const offsetY = visibleRange.startIndex * ITEM_HEIGHT;

  const renderRow = (row) => {
    if (row.type === 'op') {
      const { op, isLast } = row;
      const isSelected = selectedEntry?.id === op.id;
      return (
        <div
          key={row.key}
          className={cn(
            'flex cursor-pointer flex-col border-b p-3 pl-8 hover:bg-muted/50',
            'border-l-4 border-l-primary/30 bg-muted/20',
            isLast && 'mb-0',
            isSelected && 'bg-accent hover:bg-accent',
          )}
          style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
          onClick={() => selectOp(op)}
        >
          <div className="flex-1">
            <p className="mb-3 line-clamp-2 text-sm leading-tight">{op.description}</p>
            <div className="border-t pt-1.5">
              <p className="text-xs text-muted-foreground">{formatTime(op.time)}</p>
              {op.user && (
                <p className="text-xs text-muted-foreground">{actorLine(op.user, null)}</p>
              )}
            </div>
          </div>
        </div>
      );
    }

    const { entry, multi, expanded: isExpanded } = row;
    const isSelected = selectedEntry?.id === entry.id;
    // Highlight a collapsed unit softly when it hides the selected member op.
    const containsSelected =
      !isExpanded && multi && (entry.ops || []).some((op) => op.id === selectedEntry?.id);
    const count = entry.ops?.length || 0;
    return (
      <div
        key={row.key}
        className={cn(
          'flex cursor-pointer flex-col border-b p-3 hover:bg-muted/50',
          isSelected && 'bg-accent hover:bg-accent',
          containsSelected && 'bg-accent/40',
        )}
        style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
        onClick={() => selectUnit(entry)}
      >
        <div className="flex flex-1 gap-2">
          {multi ? (
            <button
              type="button"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={isExpanded}
              className="mt-0.5 h-5 w-5 shrink-0 rounded hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(entry.id);
              }}
            >
              <ChevronRight
                className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')}
              />
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="mb-1 line-clamp-2 text-sm font-medium leading-tight">
              {unitLabel(entry)}
            </p>
            {multi && (
              <p className="mb-2 text-xs font-semibold text-primary">
                {count} actions{entry.message ? '' : ` (${entry.batchId ? 'batch' : 'group'})`}
              </p>
            )}
            <div className="mt-auto border-t pt-1.5">
              <p className="text-xs text-muted-foreground">
                {formatTime(entry.time)}
                {multi && entry.endTime && entry.endTime !== entry.time
                  ? ` → ${formatTime(entry.endTime)}`
                  : ''}
              </p>
              {entry.user && (
                <p className="text-xs text-muted-foreground">
                  {actorLine(entry.user, entry.apiToken)}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="tw fixed left-0 top-0 z-40 flex h-screen w-[400px] flex-col border-r bg-background shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5" />
          <span className="text-lg font-semibold">Document History</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" /> Close
        </Button>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="flex flex-col items-center gap-2 py-10">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            <p className="text-sm text-muted-foreground">Loading history...</p>
          </div>
        )}

        {error && (
          <div className="p-4">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <p className="text-sm font-medium text-destructive">Error</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && reversedAuditEntries.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No history entries found</p>
          </div>
        )}

        {!loading && !error && reversedAuditEntries.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <p className="mb-4 text-xs text-muted-foreground">
              {reversedAuditEntries.length} entries • Click to view historical state
            </p>

            {/* Virtual scrolled list */}
            <div
              ref={scrollContainerRef}
              className="relative flex-1 overflow-auto rounded-md border bg-background"
              onScroll={handleScroll}
            >
              <div style={{ height: totalHeight, position: 'relative' }}>
                <div
                  style={{
                    transform: `translateY(${offsetY}px)`,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                  }}
                >
                  {rows.slice(visibleRange.startIndex, visibleRange.endIndex + 1).map(renderRow)}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer with current selection info */}
      {selectedEntry && (
        <div className="border-t bg-accent p-4">
          <div className="flex flex-col items-start gap-2">
            <Badge>Viewing Historical State</Badge>
            {selectedEntry.label && (
              <p className="line-clamp-2 text-xs font-medium">{selectedEntry.label}</p>
            )}
            <p className="text-xs text-muted-foreground">{formatTime(selectedEntry.time)}</p>
            <Button size="sm" onClick={() => onSelectEntry(null)}>
              Return to Current State
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
