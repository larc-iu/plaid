import { useState, useRef, useMemo } from 'react';
import { Drawer, Loader, Text, Button, Box, Group } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { fullTimestamp } from '../../../utils/formatTime.js';
import classes from './HistoryDrawer.module.css';

const ITEM_HEIGHT = 116; // Height of each rendered row in pixels (card + gutter; see .cardContent)
const BUFFER_SIZE = 5; // Number of rows to render outside visible area
const GROUP_THRESHOLD_MS = 5000; // Entries closer in time than this collapse together

const getEntryDescription = (entry) => entry.ops?.[0]?.description || 'No description available';

// The acting agent behind an audit entry. Two entries only glom if the SAME
// user is acting through the SAME token — an API token (by id, falling back to
// name) or the plain web session. So edits by different users, or by one user
// via different tokens, never collapse together even when near-simultaneous.
const agentKey = (entry) => {
  const actor = entry.user?.id ?? entry.user?.username ?? 'unknown';
  const token = entry.apiToken?.id ?? entry.apiToken?.name ?? 'session';
  return `${actor}::${token}`;
};

// Group consecutive entries whose timestamps fall within GROUP_THRESHOLD_MS of
// each other AND that share the same acting agent. Entries arrive
// most-recent-first, so their times descend; we compare each entry against the
// previous one in the (already reversed) list.
const groupEntries = (entries, thresholdMs) => {
  const groups = [];
  let current = null;
  for (const entry of entries) {
    const t = new Date(entry.time).getTime();
    const key = agentKey(entry);
    if (current && current.agentKey === key && Math.abs(current.lastTime - t) <= thresholdMs) {
      current.entries.push(entry);
      current.lastTime = t;
    } else {
      current = { id: entry.id, agentKey: key, lastTime: t, entries: [entry] };
      groups.push(current);
    }
  }
  return groups;
};

export const HistoryDrawer = ({
  isOpen,
  onClose,
  auditEntries,
  loading,
  onSelectEntry,
  selectedEntry
}) => {
  const [scrollTop, setScrollTop] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const scrollContainerRef = useRef(null);

  // Reverse the audit entries to show most recent first
  const reversedAuditEntries = useMemo(() => [...auditEntries].reverse(), [auditEntries]);

  const groups = useMemo(
    () => groupEntries(reversedAuditEntries, GROUP_THRESHOLD_MS),
    [reversedAuditEntries]
  );

  // Flatten the groups into a uniform-height row list so the virtual scroller
  // keeps working: every row is exactly ITEM_HEIGHT. A lone entry is one row; a
  // collapsed multi-entry group is a single header row; expanding a group
  // splices its child rows in directly below the header.
  const rows = useMemo(() => {
    const out = [];
    for (const group of groups) {
      if (group.entries.length === 1) {
        out.push({ key: group.entries[0].id, type: 'single', entry: group.entries[0] });
        continue;
      }
      const expanded = expandedGroups.has(group.id);
      out.push({ key: `group-${group.id}`, type: 'header', group, expanded });
      if (expanded) {
        group.entries.forEach((entry, i) => {
          out.push({ key: entry.id, type: 'child', entry, isLast: i === group.entries.length - 1 });
        });
      }
    }
    return out;
  }, [groups, expandedGroups]);

  // Calculate which rows should be rendered based on scroll position
  const visibleRange = useMemo(() => {
    const actualHeight = scrollContainerRef.current?.clientHeight || 400;
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
    const endIndex = Math.min(
      rows.length - 1,
      Math.ceil((scrollTop + actualHeight) / ITEM_HEIGHT) + BUFFER_SIZE
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

  // Shared body for a single audit entry (used by lone entries and group children)
  const renderEntryBody = (entry) => (
    <>
      <div style={{ flex: 1, paddingRight: '0.5rem' }}>
        <div className={classes.clamp}>{getEntryDescription(entry)}</div>
      </div>
      <div style={{ flexShrink: 0, paddingTop: '0.5rem', borderTop: '1px solid var(--mantine-color-gray-1)' }}>
        <Text size="xs" c="dimmed">{fullTimestamp(entry.time)}</Text>
        {entry.user && (
          <Text size="xs" c="dimmed">
            by {entry.user.username}{entry.apiToken ? ` (via ${entry.apiToken.name})` : ''}
          </Text>
        )}
      </div>
    </>
  );

  const renderRow = (row) => {
    if (row.type === 'single' || row.type === 'child') {
      const entry = row.entry;
      const isSelected = selectedEntry?.id === entry.id;
      const isChild = row.type === 'child';
      return (
        <div
          key={row.key}
          className={isChild ? `${classes.entry} ${classes.childEntry}` : classes.entry}
          data-selected={isSelected}
          data-last={isChild ? row.isLast : undefined}
          style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
          onClick={() => onSelectEntry(entry)}
        >
          <div className={classes.cardContent}>
            {renderEntryBody(entry)}
          </div>
        </div>
      );
    }

    // Group header row — collapsed stack of entries that occurred near-simultaneously.
    const { group, expanded } = row;
    const first = group.entries[0];
    const others = group.entries.length - 1;
    // Highlight the header when it hides the currently-selected entry.
    const containsSelected = !expanded && group.entries.some((e) => e.id === selectedEntry?.id);
    return (
      <div
        key={row.key}
        className={`${classes.entry} ${classes.groupEntry}`}
        data-expanded={expanded}
        data-selected={containsSelected}
        style={{ height: ITEM_HEIGHT, minHeight: ITEM_HEIGHT }}
        onClick={() => toggleGroup(group.id)}
      >
        <div className={`${classes.cardContent} ${classes.groupContent}`}>
          <div style={{ display: 'flex', gap: '0.4rem', flex: 1, minHeight: 0 }}>
            <IconChevronRight size={16} className={classes.chevron} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={classes.clampOne}>{getEntryDescription(first)}</div>
              <Text size="xs" fw={600} c="blue.7">
                and {others} other action{others === 1 ? '' : 's'}
              </Text>
            </div>
          </div>
          <div style={{ flexShrink: 0, paddingTop: '0.35rem', borderTop: '1px solid var(--mantine-color-gray-1)' }}>
            <Text size="xs" c="dimmed">{fullTimestamp(first.time)}</Text>
            <Text size="xs" c="dimmed">
              {group.entries.length} actions{first.user ? ` by ${first.user.username}` : ''}
              {first.apiToken ? ` (via ${first.apiToken.name})` : ''}
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
          style={{ display: 'flex', flexDirection: 'column', height: 'calc(100% - 60px)', overflow: 'hidden' }}
        >
          {loading && <Group justify="center" py="xl"><Loader size="sm" /></Group>}

          {/* Errors (audit-log load, or a failed time-travel fetch) surface as
              toasts — see useDocumentHistory. The entry list stays put so a
              transient failure doesn't wipe the history you were browsing. */}
          {!loading && reversedAuditEntries.length === 0 && (
            <Text ta="center" c="dimmed" py="xl" size="sm">No history entries found</Text>
          )}

          {!loading && reversedAuditEntries.length > 0 && (
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
                }}
              >
                <div style={{ height: totalHeight, position: 'relative' }}>
                  <div style={{ transform: `translateY(${offsetY}px)`, position: 'absolute', top: 0, left: 0, right: 0 }}>
                    {rows.slice(visibleRange.startIndex, visibleRange.endIndex + 1).map(renderRow)}
                  </div>
                </div>
              </div>
            </Box>
          )}

          {/* Footer with current selection info */}
          {selectedEntry && (
            <Box p="md" bg="blue.0" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
              <Text size="sm" fw={500} c="blue.9" mb={4}>Viewing Historical State</Text>
              <Text size="xs" c="blue.7">{fullTimestamp(selectedEntry.time)}</Text>
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
