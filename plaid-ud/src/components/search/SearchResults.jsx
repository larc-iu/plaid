import { useMemo } from 'react';
import { Stack, Paper, Text, Box, Alert, Divider } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import classes from '../common/listRow.module.css';
import { segmentize } from './grewToHighlight.js';

// Renders grouped sentence matches. `groups` come from groupResults():
// [{ docId, sentenceId, text, highlights }]. Clicking a sentence opens it in
// the annotation editor (deep-linked via ?sent=).
export const SearchResults = ({ groups, count, truncated, warnings, searched, docName, onOpen }) => {
  const byDoc = useMemo(() => {
    const m = new Map();
    for (const g of groups) {
      if (!m.has(g.docId)) m.set(g.docId, []);
      m.get(g.docId).push(g);
    }
    return [...m.entries()];
  }, [groups]);

  return (
    <Stack gap="md">
      {warnings?.length > 0 && (
        <Alert color="yellow" icon={<IconInfoCircle size={16} />} title="Notes">
          <Stack gap={2}>{warnings.map((w, i) => <Text key={i} size="sm">{w}</Text>)}</Stack>
        </Alert>
      )}

      {searched && (
        <Text size="sm" c="dimmed">
          {groups.length === 0
            ? 'No matching sentences.'
            : `${groups.length} matching sentence${groups.length === 1 ? '' : 's'}` +
              (truncated ? ` (showing the first ${count}; refine the query for more)` : '')}
        </Text>
      )}

      {byDoc.map(([docId, sentences]) => (
        <Paper key={docId} withBorder radius="md">
          <Box px="md" py="xs" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
            <Text fw={600} size="sm" truncate>{docName(docId) || docId}</Text>
          </Box>
          <Stack gap={0}>
            {sentences.map((s, idx) => (
              <Box key={s.sentenceId}>
                {idx > 0 && <Divider />}
                <Box className={classes.row} p="md" onClick={() => onOpen(s.docId, s.sentenceId)}>
                  <Text size="sm" style={{ lineHeight: 1.6 }}>
                    {segmentize(s.text, s.highlights).map((seg, i) =>
                      seg.hl
                        ? <Box key={i} component="mark" style={{ background: 'var(--mantine-color-yellow-2)', borderRadius: 3, padding: '0 2px' }}>{seg.text}</Box>
                        : <span key={i}>{seg.text}</span>,
                    )}
                  </Text>
                </Box>
              </Box>
            ))}
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};
