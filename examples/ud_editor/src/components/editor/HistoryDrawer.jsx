import { useState, useEffect, useRef, useMemo } from 'react';

const ITEM_HEIGHT = 100; // Height of each audit entry in pixels
const BUFFER_SIZE = 5; // Number of items to render outside visible area

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
  const [containerHeight, setContainerHeight] = useState(400);

  // Reverse the audit entries to show most recent first
  const reversedAuditEntries = [...auditEntries].reverse();

  // Calculate which items should be rendered based on scroll position
  const visibleRange = useMemo(() => {
    // Get the actual container height from the DOM if available
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
    <div className="fixed left-0 top-0 h-full w-96 bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Document History</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="h-full flex flex-col">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-gray-600">Loading history...</div>
            </div>
          )}

          {error && (
            <div className="p-4">
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
                {error}
              </div>
            </div>
          )}

          {!loading && !error && reversedAuditEntries.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-gray-500">No history entries found</div>
            </div>
          )}

          {!loading && !error && reversedAuditEntries.length > 0 && (
            <div className="flex-1 flex flex-col p-4 min-h-0">
              <div className="text-xs text-gray-500 mb-3">
                {reversedAuditEntries.length} entries • Click to view historical state
              </div>
              
              {/* Virtual scrolled list - takes remaining space */}
              <div 
                ref={scrollContainerRef}
                className="border border-gray-200 rounded-md overflow-auto flex-1"
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
                    {reversedAuditEntries.slice(visibleRange.startIndex, visibleRange.endIndex + 1).map((entry, index) => {
                      const actualIndex = visibleRange.startIndex + index;
                      const isSelected = selectedEntry?.id === entry.id;
                      
                      return (
                        <div
                          key={entry.id}
                          className={`border-b border-gray-100 cursor-pointer transition-colors ${
                            isSelected 
                              ? 'bg-blue-50 hover:bg-blue-100' 
                              : 'hover:bg-gray-50'
                          }`}
                          style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
                          onClick={() => handleEntryClick(entry)}
                        >
                          <div className="p-3 h-full flex flex-col justify-between">
                            <div className="flex-1 pr-2">
                              <div 
                                className="text-sm font-medium text-gray-900 break-words overflow-hidden"
                                style={{
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  lineHeight: '1.3',
                                  maxHeight: '2.6em' // Ensure it never exceeds 2 lines
                                }}
                              >
                                {getEntryDescription(entry)}
                              </div>
                            </div>
                            <div className="flex-shrink-0 pt-2 border-t border-gray-100">
                              <div className="text-xs text-gray-500 mb-1">
                                {formatTime(entry.time)}
                              </div>
                              {entry.user && (
                                <div className="text-xs text-gray-400">
                                  by {entry.user.username}{entry.userAgent ? ` (via ${entry.userAgent})` : ""}
                                </div>
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
          <div className="border-t border-gray-200 p-4 bg-blue-50">
            <div className="text-sm font-medium text-blue-900 mb-1">
              Viewing Historical State
            </div>
            <div className="text-xs text-blue-700">
              {formatTime(selectedEntry.time)}
            </div>
            <button
              onClick={() => onSelectEntry(null)}
              className="mt-2 text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 transition-colors"
            >
              Return to Current State
            </button>
          </div>
        )}
      </div>
  );
};