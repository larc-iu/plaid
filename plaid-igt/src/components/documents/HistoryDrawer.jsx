import { useState, useMemo } from 'react';
import { X, History, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// The audit log arrives already folded into logical units by the server: a
// labeled operation ("Merge morphemes"), else an atomic batch, else a lone
// write. `entry.ops` is the unit's full membership (oldest first); `time` is
// the head op's time and `endTime` the last member's — the state AFTER the
// whole operation, which is what selecting a unit travels to.
//
// Rows size to their content (no fixed-height virtualization): a lone write
// is two short lines, a multi-op unit adds a count badge and can expand.
const unitLabel = (entry) =>
  entry.message || entry.ops?.[0]?.description || 'No description available';

const formatTime = (timestamp) => new Date(timestamp).toLocaleString();

const actor = (user, apiToken) =>
  user ? ` · by ${user.displayName}${apiToken ? ` (via ${apiToken.name})` : ''}` : '';

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

  // Selecting a unit views the document as it was AFTER the whole operation;
  // selecting one of its member ops views the state right after that op.
  const selectUnit = (entry) =>
    onSelectEntry({ id: entry.id, time: entry.endTime || entry.time, label: unitLabel(entry) });
  const selectOp = (op) => onSelectEntry({ id: op.id, time: op.time, label: op.description });

  const renderOp = (entry, op, isLast) => {
    const isSelected = selectedEntry?.id === op.id;
    return (
      <div
        key={`${entry.id}:${op.id}`}
        className={cn(
          'cursor-pointer border-b border-l-4 border-l-primary/30 bg-muted/20 py-2 pl-9 pr-3 hover:bg-muted/50',
          isLast && 'border-b',
          isSelected && 'bg-accent hover:bg-accent',
        )}
        onClick={() => selectOp(op)}
      >
        <p className="line-clamp-2 text-sm leading-snug">{op.description}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatTime(op.time)}
          {actor(op.user, null)}
        </p>
      </div>
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
        ? `${formatTime(entry.time)} → ${formatTime(entry.endTime)}`
        : undefined;
    return (
      <div key={entry.id}>
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
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug">
              {multi && (
                <span className="mr-1.5 inline-block rounded bg-primary/10 px-1.5 py-px align-[1px] text-[11px] font-semibold text-primary">
                  {ops.length} actions
                </span>
              )}
              {unitLabel(entry)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground" title={range}>
              {formatTime(entry.time)}
              {actor(entry.user, entry.apiToken)}
            </p>
          </div>
        </div>
        {isExpanded &&
          [...ops].reverse().map((op, i, arr) => renderOp(entry, op, i === arr.length - 1))}
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
            <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
              {reversedAuditEntries.map(renderUnit)}
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
