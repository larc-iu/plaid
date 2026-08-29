import { useState, useMemo } from 'react';
import { Drawer, Loader, Text, Button, Box, Group, Badge } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { fullTimestamp } from '../../../utils/formatTime.js';
import classes from './HistoryDrawer.module.css';

// The audit log arrives already folded into logical units by the server: a
// labeled operation ("Merge morphemes"), else an atomic batch, else a lone
// write. `entry.ops` is the unit's full membership (oldest first); `time` is
// the head op's time and `endTime` the last member's — the state AFTER the
// whole operation, which is what selecting a unit travels to.
//
// Cards size to their content (no fixed-height virtualization): a lone write
// is a label plus one meta line, a multi-op unit adds a count badge and can
// expand into its member ops.
const unitLabel = (entry) =>
  entry.message || entry.ops?.[0]?.description || 'No description available';

const actor = (user, apiToken) =>
  user ? ` · by ${user.displayName}${apiToken ? ` (via ${apiToken.name})` : ''}` : '';

export const HistoryDrawer = ({
  isOpen,
  onClose,
  auditEntries,
  loading,
  onSelectEntry,
  selectedEntry,
}) => {
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  // Reverse the audit entries to show most recent first
  const reversedAuditEntries = useMemo(() => [...auditEntries].reverse(), [auditEntries]);

  const toggleGroup = (groupId) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Selecting a unit views the document as it was AFTER the whole operation;
  // selecting one of its member ops views the state right after that op.
  const selectUnit = (entry) =>
    onSelectEntry({ id: entry.id, time: entry.endTime || entry.time, label: unitLabel(entry) });
  const selectOp = (op) => onSelectEntry({ id: op.id, time: op.time, label: op.description });

  const meta = (time, user, apiToken, title) => (
    <Text size="xs" c="dimmed" mt={4} title={title}>
      {fullTimestamp(time)}
      {actor(user, apiToken)}
    </Text>
  );

  const renderOp = (entry, op, isLast) => {
    const isSelected = selectedEntry?.id === op.id;
    return (
      <div
        key={`${entry.id}:${op.id}`}
        className={`${classes.entry} ${classes.childEntry}`}
        data-selected={isSelected}
        data-last={isLast}
        onClick={() => selectOp(op)}
      >
        <div className={classes.cardContent}>
          <div className={classes.clamp}>{op.description}</div>
          {meta(op.time, op.user, null)}
        </div>
      </div>
    );
  };

  const renderUnit = (entry) => {
    const ops = entry.ops || [];
    const multi = ops.length > 1;
    const expanded = multi && expandedGroups.has(entry.id);
    const isSelected = selectedEntry?.id === entry.id;
    // Highlight a collapsed unit when it hides the currently-selected member op.
    const containsSelected = !expanded && multi && ops.some((op) => op.id === selectedEntry?.id);
    const range =
      multi && entry.endTime && entry.endTime !== entry.time
        ? `${fullTimestamp(entry.time)} → ${fullTimestamp(entry.endTime)}`
        : undefined;
    // Clicking the card selects the unit (the state after its last op); the
    // chevron expands the member ops.
    return (
      <div key={entry.id}>
        <div
          className={multi ? `${classes.entry} ${classes.groupEntry}` : classes.entry}
          data-expanded={expanded}
          data-selected={isSelected || containsSelected}
          onClick={() => selectUnit(entry)}
        >
          <div
            className={
              multi ? `${classes.cardContent} ${classes.groupContent}` : classes.cardContent
            }
          >
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {multi && (
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
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={classes.clamp}>
                  {multi && (
                    <Badge size="xs" variant="light" mr={6} style={{ verticalAlign: '1px' }}>
                      {ops.length} actions
                    </Badge>
                  )}
                  {unitLabel(entry)}
                </div>
                {meta(entry.time, entry.user, entry.apiToken, range)}
              </div>
            </div>
          </div>
        </div>
        {expanded &&
          [...ops].reverse().map((op, i, arr) => renderOp(entry, op, i === arr.length - 1))}
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
              <div style={{ flex: 1, overflow: 'auto' }}>
                {reversedAuditEntries.map(renderUnit)}
              </div>
            </Box>
          )}

          {/* Footer with current selection info */}
          {selectedEntry && (
            <Box p="md" bg="blue.0" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
              <Text size="sm" fw={500} c="blue.9" mb={4}>
                Viewing Historical State
              </Text>
              {selectedEntry.label && (
                <Text size="xs" c="blue.9" lineClamp={2}>
                  {selectedEntry.label}
                </Text>
              )}
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
