import { useState, useRef, useMemo } from 'react';
import { X, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const ITEM_HEIGHT = 120; // Height of each audit entry in pixels
const BUFFER_SIZE = 5; // Number of items to render outside visible area

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
  selectedEntry
}) => {
  const [scrollTop, setScrollTop] = useState(0);
  const scrollContainerRef = useRef(null);

  // Reverse the audit entries to show most recent first
  const reversedAuditEntries = [...auditEntries].reverse();

  // Calculate which items should be rendered based on scroll position
  const visibleRange = useMemo(() => {
    const actualHeight = scrollContainerRef.current?.clientHeight || 400;
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
    const endIndex = Math.min(
      reversedAuditEntries.length - 1,
      Math.ceil((scrollTop + actualHeight) / ITEM_HEIGHT) + BUFFER_SIZE
    );
    return { startIndex, endIndex };
  }, [scrollTop, reversedAuditEntries.length]);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
  };

  const handleEntryClick = (entry) => {
    onSelectEntry(entry);
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const getEntryDescription = (entry) => {
    return entry.ops?.[0]?.description || 'No description available';
  };

  // Calculate total height and spacer heights for virtual scrolling
  const totalHeight = reversedAuditEntries.length * ITEM_HEIGHT;
  const offsetY = visibleRange.startIndex * ITEM_HEIGHT;

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
                    right: 0
                  }}
                >
                  {reversedAuditEntries.slice(visibleRange.startIndex, visibleRange.endIndex + 1).map((entry) => {
                    const isSelected = selectedEntry?.id === entry.id;

                    return (
                      <div
                        key={entry.id}
                        className={cn(
                          'flex cursor-pointer flex-col border-b p-3 hover:bg-muted/50',
                          isSelected && 'bg-accent hover:bg-accent'
                        )}
                        style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
                        onClick={() => handleEntryClick(entry)}
                      >
                        <div className="flex-1">
                          <p className="mb-3 text-sm font-medium leading-tight">
                            {getEntryDescription(entry)}
                          </p>

                          <div className="border-t pt-1.5">
                            <p className="text-xs text-muted-foreground">
                              {formatTime(entry.time)}
                            </p>
                            {entry.user && (
                              <p className="text-xs text-muted-foreground">
                                by {entry.user.username}
                                {entry.userAgent && ` (via ${entry.userAgent})`}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
            <p className="text-xs text-muted-foreground">
              {formatTime(selectedEntry.time)}
            </p>
            <Button size="sm" onClick={() => onSelectEntry(null)}>
              Return to Current State
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
