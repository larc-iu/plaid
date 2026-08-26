import { useState, useRef, useMemo } from 'react';
import { Drawer, Loader, Text, Button, Box, Group } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { fullTimestamp } from '../../../utils/formatTime.js';
import classes from './HistoryDrawer.module.css';

const ITEM_HEIGHT = 116; // Height of each rendered row in pixels (card + gutter; see .cardContent)
const BUFFER_SIZE = 5; // Number of rows to render outside visible area

// The audit log arrives already folded into logical units by the server: a
// labeled operation ("Merge morphemes"), else an atomic batch, else a lone
// write. `entry.ops` is the unit's full membership (oldest first); `time` is
// the head op's time and `endTime` the last member's — the state AFTER the
// whole operation, which is what selecting a unit travels to.
const unitLabel = (entry) =>
  entry.message || entry.ops?.[0]?.description || 'No description available';

export const HistoryDrawer = ({
  isOpen,
  onClose,
  auditEntries,
  loading,
  onSelectEntry,
  selectedEntry,
}) => {
  const [scrollTop, setScrollTop] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const scrollContainerRef = useRef(null);

  // Reverse the audit entries to show most recent first
  const reversedAuditEntries = useMemo(() => [...auditEntries].reverse(), [auditEntries]);

  // Flatten the units into a uniform-height row list so the virtual scroller
  // keeps working: every row is exactly ITEM_HEIGHT. A single-op unit is one
  // row; a multi-op unit is a header row; expanding it splices its member ops
  // (newest first, matching the list direction) in directly below the header.
  const rows = useMemo(() => {
    const out = [];
    for (const entry of reversedAuditEntries) {
      const ops = entry.ops || [];
      if (ops.length <= 1) {
        out.push({ key: entry.id, type: 'single', entry });
        continue;
      }
      const expanded = expandedGroups.has(entry.id);
      out.push({ key: `group-${entry.id}`, type: 'header', entry, expanded });
      if (expanded) {
        const children = [...ops].reverse();
        children.forEach((op, i) => {
          out.push({
            key: `${entry.id}:${op.id}`,
            type: 'child',
            entry,
            op,
            isLast: i === children.length - 1,
          });
        });
      }
    }
    return out;
  }, [reversedAuditEntries, expandedGroups]);

  // Selecting a unit views the document as it was AFTER the whole operation;
  // selecting one of its member ops views the state right after that op.
  const selectUnit = (entry) =>
    onSelectEntry({ id: entry.id, time: entry.endTime || entry.time, label: unitLabel(entry) });
  const selectOp = (op) => onSelectEntry({ id: op.id, time: op.time, label: op.description });

  // Calculate which rows should be rendered based on scroll position
  const visibleRange = useMemo(() => {
    const actualHeight = scrollContainerRef.current?.clientHeight || 400;
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
    const endIndex = Math.min(
      rows.length - 1,
      Math.ceil((scrollTop + actualHeight) / ITEM_HEIGHT) + BUFFER_SIZE,
    );
    return { startIndex, endIndex };
  }, [scrollTop, rows.length]);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
  };

  const toggleGroup = (groupId) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Calculate total height and offset for virtual scrolling
  const totalHeight = rows.length * ITEM_HEIGHT;
  const offsetY = visibleRange.startIndex * ITEM_HEIGHT;

  // Body of a card: a description line plus the time / actor footer.
  const renderBody = (description, time, user, apiToken) => (
    <>
      <div style={{ flex: 1, paddingRight: '0.5rem' }}>
        <div className={classes.clamp}>{description}</div>
      </div>
      <div
        style={{
          flexShrink: 0,
          paddingTop: '0.5rem',
          borderTop: '1px solid var(--mantine-color-gray-1)',
        }}
      >
        <Text size="xs" c="dimmed">
          {fullTimestamp(time)}
        </Text>
        {user && (
          <Text size="xs" c="dimmed">
            by {user.username}
            {apiToken ? ` (via ${apiToken.name})` : ''}
          </Text>
        )}
      </div>
    </>
  );

  const renderRow = (row) => {
    if (row.type === 'single') {
      const { entry } = row;
      const isSelected = selectedEntry?.id === entry.id;
      return (
        <div
          key={row.key}
          className={classes.entry}
          data-selected={isSelected}
          style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
          onClick={() => selectUnit(entry)}
        >
          <div className={classes.cardContent}>
            {renderBody(unitLabel(entry), entry.time, entry.user, entry.apiToken)}
          </div>
        </div>
      );
    }

    if (row.type === 'child') {
      const { op } = row;
      const isSelected = selectedEntry?.id === op.id;
      return (
        <div
          key={row.key}
          className={`${classes.entry} ${classes.childEntry}`}
          data-selected={isSelected}
          data-last={row.isLast}
          style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
          onClick={() => selectOp(op)}
        >
          <div className={classes.cardContent}>
            {renderBody(op.description, op.time, op.user, null)}
          </div>
        </div>
      );
    }

    // Header row of a multi-op unit. Clicking the card selects the unit (the
    // state after its last op); the chevron expands the member ops.
    const { entry, expanded } = row;
    const ops = entry.ops || [];
    const isSelected = selectedEntry?.id === entry.id;
    // Highlight the header when it hides the currently-selected member op.
    const containsSelected = !expanded && ops.some((op) => op.id === selectedEntry?.id);
    return (
      <div
        key={row.key}
        className={`${classes.entry} ${classes.groupEntry}`}
        data-expanded={expanded}
        data-selected={isSelected || containsSelected}
        style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
        onClick={() => selectUnit(entry)}
      >
        <div className={`${classes.cardContent} ${classes.groupContent}`}>
          <div style={{ display: 'flex', gap: '0.4rem', flex: 1, minHeight: 0 }}>
            <button
              type="button"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-expanded={expanded}
              className={classes.chevronButton}
              onClick={(e) => {
                e.stopPropagation();
                toggleGroup(entry.id);
              }}
            >
              <IconChevronRight size={16} className={classes.chevron} />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={classes.clampOne}>{unitLabel(entry)}</div>
              <Text size="xs" fw={600} c="blue.7">
                {ops.length} actions
                {entry.message ? '' : entry.batchId ? ' (batch)' : ''}
              </Text>
            </div>
          </div>
          <div
            style={{
              flexShrink: 0,
              paddingTop: '0.35rem',
              borderTop: '1px solid var(--mantine-color-gray-1)',
            }}
          >
            <Text size="xs" c="dimmed">
              {fullTimestamp(entry.time)}
              {entry.endTime && entry.endTime !== entry.time
                ? ` → ${fullTimestamp(entry.endTime)}`
                : ''}
            </Text>
            <Text size="xs" c="dimmed">
              {entry.user ? `by ${entry.user.username}` : ''}
              {entry.apiToken ? ` (via ${entry.apiToken.name})` : ''}
            </Text>
          </div>
        </div>
      </div>
    );
  };

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
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: 'calc(100% - 60px)',
            overflow: 'hidden',
          }}
        >
          {loading && (
            <Group justify="center" py="xl">
              <Loader size="sm" />
            </Group>
          )}

          {/* Errors (audit-log load, or a failed time-travel fetch) surface as
              toasts — see useDocumentHistory. The entry list stays put so a
              transient failure doesn't wipe the history you were browsing. */}
          {!loading && reversedAuditEntries.length === 0 && (
            <Text ta="center" c="dimmed" py="xl" size="sm">
              No history entries found
            </Text>
          )}

          {!loading && reversedAuditEntries.length > 0 && (
            <Box
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                padding: '1rem',
              }}
            >
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
                }}
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
            </Box>
          )}

          {/* Footer with current selection info */}
          {selectedEntry && (
            <Box p="md" bg="blue.0" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
              <Text size="sm" fw={500} c="blue.9" mb={4}>
                Viewing Historical State
              </Text>
              <Text size="xs" c="blue.7">
                {fullTimestamp(selectedEntry.time)}
              </Text>
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
