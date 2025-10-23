import { useState, useRef, useMemo } from 'react';
import { 
  Drawer, 
  Stack, 
  Text, 
  Button, 
  Loader, 
  Center, 
  Alert, 
  ScrollArea, 
  Group,
  Box,
  Paper,
  Badge
} from '@mantine/core';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import IconHistory from '@tabler/icons-react/dist/esm/icons/IconHistory.mjs';

const ITEM_HEIGHT = 120; // Height of each audit entry in pixels
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
    <Drawer 
      opened={isOpen} 
      onClose={onClose}
      position="left"
      size={400}
      withCloseButton={false}
      withOverlay={false}
      removeScrollProps={{ enabled: false }}
      styles={{
        content: {
          padding: 0,
          height: '100vh'
        },
        body: {
          padding: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column'
        }
      }}
    >
      {/* Header */}
      <Group justify="space-between" p="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-3)' }}>
        <Group>
          <IconHistory size={20} />
          <Text size="lg" fw={600}>Document History</Text>
        </Group>
        <Button 
          variant="subtle" 
          size="sm" 
          onClick={onClose}
          leftSection={<IconX size={16} />}
        >
          Close
        </Button>
      </Group>

      {/* Content */}
      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {loading && (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="lg" />
              <Text size="sm" c="dimmed">Loading history...</Text>
            </Stack>
          </Center>
        )}

        {error && (
          <Box p="md">
            <Alert color="red" title="Error">
              {error}
            </Alert>
          </Box>
        )}

        {!loading && !error && reversedAuditEntries.length === 0 && (
          <Center py="xl">
            <Text size="sm" c="dimmed">No history entries found</Text>
          </Center>
        )}

        {!loading && !error && reversedAuditEntries.length > 0 && (
          <Box p="md" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Text size="xs" c="dimmed" mb="md">
              {reversedAuditEntries.length} entries • Click to view historical state
            </Text>
            
            {/* Virtual scrolled list */}
            <Box 
              ref={scrollContainerRef}
              style={{ 
                flex: 1, 
                border: '1px solid var(--mantine-color-gray-3)', 
                borderRadius: 'var(--mantine-radius-sm)',
                position: 'relative',
                overflow: 'auto',
                backgroundColor: 'white'
              }}
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
                    const isSelected = selectedEntry?.id === entry.id;
                    
                    return (
                      <Box
                        key={entry.id}
                        style={{ 
                          height: ITEM_HEIGHT, 
                          minHeight: ITEM_HEIGHT,
                          borderBottom: '1px solid var(--mantine-color-gray-3)',
                          cursor: 'pointer',
                          backgroundColor: isSelected ? 'var(--mantine-color-blue-0)' : 'white',
                          padding: '12px',
                          display: 'flex',
                          flexDirection: 'column'
                        }}
                        onClick={() => handleEntryClick(entry)}
                        __vars={{
                          '--hover-bg': isSelected ? 'var(--mantine-color-blue-1)' : 'var(--mantine-color-gray-0)'
                        }}
                        sx={{
                          '&:hover': {
                            backgroundColor: 'var(--hover-bg)'
                          }
                        }}
                      >
                        <Box style={{ flex: 1 }}>
                          <Text 
                            size="sm" 
                            fw={500} 
                            style={{
                              lineHeight: 1.3,
                              marginBottom: '12px'
                            }}
                          >
                            {getEntryDescription(entry)}
                          </Text>
                          
                          <Box style={{ borderTop: '1px solid var(--mantine-color-gray-2)', paddingTop: '6px' }}>
                            <Text size="xs" c="dimmed">
                              {formatTime(entry.time)}
                            </Text>
                            {entry.user && (
                              <Text size="xs" c="dimmed">
                                by {entry.user.username}
                                {entry.userAgent && ` (via ${entry.userAgent})`}
                              </Text>
                            )}
                          </Box>
                        </Box>
                      </Box>
                    );
                  })}
                </div>
              </div>
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer with current selection info */}
      {selectedEntry && (
        <Box p="md" bg="blue.0" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
          <Stack gap="xs">
            <Badge color="blue" variant="filled">
              Viewing Historical State
            </Badge>
            <Text size="xs" c="blue.7">
              {formatTime(selectedEntry.time)}
            </Text>
            <Button
              size="xs"
              onClick={() => onSelectEntry(null)}
              variant="filled"
              color="blue"
            >
              Return to Current State
            </Button>
          </Stack>
        </Box>
      )}
    </Drawer>
  );
};