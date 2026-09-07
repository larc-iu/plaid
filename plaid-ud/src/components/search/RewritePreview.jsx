import { useMemo, useState, useEffect } from 'react';
import {
  Stack,
  Paper,
  Text,
  Box,
  Divider,
  Group,
  Checkbox,
  Button,
  Badge,
  Anchor,
} from '@mantine/core';
import { Link } from 'react-router-dom';
import { modals } from '@mantine/modals';
import { pageSlice } from '../../hooks/usePagedList.js';
import { ListPager } from '../common/ListChrome.jsx';

const PAGE_SIZE = 50; // sentences per page

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The rewrite preview: every sentence a rule changed, grouped by document,
// each with its change lines and a checkbox. `rows` come from planRewrite;
// `selected` is the set of row keys to apply. Sentences are links into the
// annotation editor (deep-linked via ?sent=), built by `hrefFor`.
export const RewritePreview = ({ rows, selected, onSelect, hrefFor, canApply, busy, onApply }) => {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [rows]);

  const paged = useMemo(() => pageSlice(rows, page, PAGE_SIZE), [rows, page]);
  const { pageItems } = paged;
  const byDoc = useMemo(() => {
    const m = new Map();
    for (const r of pageItems) {
      if (!m.has(r.docId)) m.set(r.docId, []);
      m.get(r.docId).push(r);
    }
    return [...m.entries()];
  }, [pageItems]);

  const applicable = rows.filter((r) => !r.error);
  const chosen = applicable.filter((r) => selected.has(r.key));
  const chosenDocs = new Set(chosen.map((r) => r.docId));
  const errors = rows.length - applicable.length;
  const warned = rows.filter((r) => r.warnings.length).length;

  const setMany = (keys, on) => {
    const next = new Set(selected);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    onSelect(next);
  };

  const confirmApply = () =>
    modals.openConfirmModal({
      title: 'Apply changes?',
      children: (
        <Text size="sm">
          {plural(chosen.length, 'sentence')} in {plural(chosenDocs.size, 'document')}.
        </Text>
      ),
      labels: { confirm: 'Apply', cancel: 'Cancel' },
      onConfirm: onApply,
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          {rows.length === 0
            ? 'No sentences to change.'
            : `${plural(rows.length, 'sentence')} in ${plural(new Set(rows.map((r) => r.docId)).size, 'document')}, ${chosen.length} selected` +
              (errors ? `, ${plural(errors, 'error')}` : '') +
              (warned ? `, ${plural(warned, 'warning')}` : '')}
        </Text>
        {rows.length > 0 && (
          <Group gap="xs">
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() =>
                setMany(
                  applicable.map((r) => r.key),
                  chosen.length !== applicable.length,
                )
              }
            >
              {chosen.length !== applicable.length ? 'Select all' : 'Select none'}
            </Button>
            {canApply ? (
              <Button onClick={confirmApply} disabled={!chosen.length} loading={busy}>
                Apply {plural(chosen.length, 'change')}
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                Maintainers only.
              </Text>
            )}
          </Group>
        )}
      </Group>

      <ListPager {...paged} onPage={setPage} position="top" />

      {byDoc.map(([docId, sentences]) => {
        const keys = sentences.filter((r) => !r.error).map((r) => r.key);
        const on = keys.filter((k) => selected.has(k)).length;
        return (
          <Paper key={docId} withBorder radius="md">
            <Group
              px="md"
              py="xs"
              gap="sm"
              style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}
            >
              <Checkbox
                size="sm"
                checked={keys.length > 0 && on === keys.length}
                indeterminate={on > 0 && on < keys.length}
                disabled={!keys.length}
                onChange={(e) => setMany(keys, e.currentTarget.checked)}
                aria-label="Select document"
              />
              <Text fw={600} size="sm" truncate>
                {sentences[0].docName}
              </Text>
            </Group>
            <Stack gap={0}>
              {sentences.map((r, idx) => (
                <Box key={r.key}>
                  {idx > 0 && <Divider />}
                  <Group p="md" gap="sm" align="flex-start" wrap="nowrap">
                    <Checkbox
                      size="sm"
                      mt={2}
                      checked={selected.has(r.key)}
                      disabled={!!r.error}
                      onChange={(e) => setMany([r.key], e.currentTarget.checked)}
                      aria-label="Select sentence"
                    />
                    <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                      <Group gap="xs" wrap="nowrap">
                        <Anchor
                          component={Link}
                          to={hrefFor(r.docId, r.id)}
                          size="sm"
                          style={{ lineHeight: 1.6 }}
                        >
                          {r.text}
                        </Anchor>
                        {r.applications > 1 && (
                          <Badge size="xs" variant="light" color="gray">
                            {r.applications}×
                          </Badge>
                        )}
                      </Group>
                      {r.changes.map((c, i) => (
                        <Text key={i} size="xs" ff="monospace">
                          {c.text}
                        </Text>
                      ))}
                      {r.warnings.map((w, i) => (
                        <Text key={i} size="xs" c="yellow.8">
                          {w}
                        </Text>
                      ))}
                      {r.error && (
                        <Text size="xs" c="red.7">
                          {r.error}
                        </Text>
                      )}
                    </Stack>
                  </Group>
                </Box>
              ))}
            </Stack>
          </Paper>
        );
      })}

      <ListPager {...paged} onPage={setPage} />
    </Stack>
  );
};
