import { useState, useRef, useMemo } from 'react';
import { Drawer, Loader, Alert, Text, Button, Box, Group } from '@mantine/core';
import classes from './HistoryDrawer.module.css';

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

  return (
    // No overlay / focus trap: the point of history is to view the annotation
    // grid in a past state, so the grid must stay visible and interactive while
    // the drawer is open.
    <Drawer.Root
      opened={isOpen}
      onClose={onClose}
      position="left"
      size={384}
      trapFocus={false}
      lockScroll={false}
      closeOnClickOutside={false}
    >
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title fw={600}>Document History</Drawer.Title>
          <Drawer.CloseButton />
        </Drawer.Header>

        <Drawer.Body
          p={0}
          style={{ display: 'flex', flexDirection: 'column', height: 'calc(100% - 60px)', overflow: 'hidden' }}
        >
          {loading && <Group justify="center" py="xl"><Loader size="sm" /></Group>}

          {error && <Box p="md"><Alert color="red">{error}</Alert></Box>}

          {!loading && !error && reversedAuditEntries.length === 0 && (
            <Text ta="center" c="dimmed" py="xl" size="sm">No history entries found</Text>
          )}

          {!loading && !error && reversedAuditEntries.length > 0 && (
            <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '1rem' }}>
              <Text size="xs" c="dimmed" mb="sm">
                {reversedAuditEntries.length} entries • Click to view historical state
              </Text>

              {/* Virtual scrolled list - takes remaining space */}
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                style={{
                  flex: 1,
                  overflow: 'auto',
                  border: '1px solid var(--mantine-color-gray-2)',
                  borderRadius: 'var(--mantine-radius-sm)',
                }}
              >
                <div style={{ height: totalHeight, position: 'relative' }}>
                  <div style={{ transform: `translateY(${offsetY}px)`, position: 'absolute', top: 0, left: 0, right: 0 }}>
                    {reversedAuditEntries.slice(visibleRange.startIndex, visibleRange.endIndex + 1).map((entry) => {
                      const isSelected = selectedEntry?.id === entry.id;

                      return (
                        <div
                          key={entry.id}
                          className={classes.entry}
                          data-selected={isSelected}
                          style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
                          onClick={() => handleEntryClick(entry)}
                        >
                          <div style={{ padding: '0.75rem', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                            <div style={{ flex: 1, paddingRight: '0.5rem' }}>
                              <div className={classes.clamp}>{getEntryDescription(entry)}</div>
                            </div>
                            <div style={{ flexShrink: 0, paddingTop: '0.5rem', borderTop: '1px solid var(--mantine-color-gray-1)' }}>
                              <Text size="xs" c="dimmed">{formatTime(entry.time)}</Text>
                              {entry.user && (
                                <Text size="xs" c="dimmed">
                                  by {entry.user.username}{entry.apiToken ? ` (via ${entry.apiToken.name})` : ''}
                                </Text>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Box>
          )}

          {/* Footer with current selection info */}
          {selectedEntry && (
            <Box p="md" bg="blue.0" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
              <Text size="sm" fw={500} c="blue.9" mb={4}>Viewing Historical State</Text>
              <Text size="xs" c="blue.7">{formatTime(selectedEntry.time)}</Text>
              <Button size="xs" mt="xs" onClick={() => onSelectEntry(null)}>
                Return to Current State
              </Button>
            </Box>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
};