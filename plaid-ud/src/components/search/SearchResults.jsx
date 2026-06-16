import { useMemo, useState, useEffect } from 'react';
import { Stack, Paper, Text, Box, Alert, Divider, Group, Pagination } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconInfoCircle } from '@tabler/icons-react';
import classes from '../common/listRow.module.css';
import { segmentize } from './grewToHighlight.js';

const PAGE_SIZE = 50; // matched sentences per page

// Renders grouped sentence matches. `groups` come from groupResults():
// [{ docId, sentenceId, text, highlights }]. Each sentence is a real link to
// the annotation editor (deep-linked via ?sent=), built by `hrefFor`. The full
// match set is paged client-side (the query API returns all matches at once —
// it has no offset/cursor).
export const SearchResults = ({ groups, count, truncated, warnings, searched, docName, hrefFor }) => {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [groups]);

  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  // Group only the current page's sentences by document for rendering.
  const byDoc = useMemo(() => {
    const slice = groups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const m = new Map();
    for (const g of slice) {
      if (!m.has(g.docId)) m.set(g.docId, []);
      m.get(g.docId).push(g);
    }
    return [...m.entries()];
  }, [groups, currentPage]);

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
              (truncated ? ` (capped at ${count}; refine the query for more)` : '')}
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
                <Box className={classes.row} p="md" component={Link} to={hrefFor(s.docId, s.sentenceId)}>
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

      {totalPages > 1 && (
        <Group justify="center" mt="xs">
          <Pagination total={totalPages} value={currentPage} onChange={setPage} />
        </Group>
      )}
    </Stack>
  );
};
