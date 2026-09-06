// Restore a document to the state selected in the History drawer. The server
// does the work in one operation (documents.restore); the confirm step asks it
// for a dry run and lists what would change, and the toast that confirms the
// restore offers Undo.

import { useEffect, useRef, useState } from 'react';
import { Button, Group, List, Loader, Modal, Stack, Text } from '@mantine/core';
import { changeLines, indexLayers, skippedLines } from '../../../domain/restoreSummary.js';
import {
  notifySuccess,
  notifyError,
  notifyWarning,
  notifyPromise,
  notifyWithAction,
} from '../../../utils/feedback.jsx';
import { fullTimestamp } from '../../../utils/formatTime.js';

const historyMessage = (asOf, label) =>
  `Restore to ${fullTimestamp(asOf)}` + (label ? ` (after “${label}”)` : '');

// A 409 from the restore is the server saying the old state no longer fits a
// layer as it is now, and it says which one — worth passing through verbatim.
// Anything else gets the usual treatment.
const restoreError = (err, fallback) => {
  const m = String(err?.message || '');
  if (/no longer fits/.test(m)) {
    return m.replace(/^HTTP \d+\s*/, '').replace(/\s*at\s+https?:\/\/\S+/, '');
  }
  return m ? `${fallback} (${m})` : fallback;
};

// The document's newest history entry: the moment its live state belongs to,
// and what that entry is called. Read BEFORE a restore so the state from just
// before it can be brought back.
const latestState = async (client, documentId) => {
  const entries = await client.documents.audit(documentId);
  const last = entries?.[entries.length - 1];
  if (!last) return null;
  return {
    time: last.endTime || last.time,
    label: last.message || last.ops?.[0]?.description || null,
  };
};

export const RestoreDialog = ({ opened, onClose, client, documentId, raw, entry, onRestored }) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asOf = entry?.time ?? null;
  // The toast's Undo fires long after this render, so it reads the latest
  // callback rather than the one it closed over.
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;

  useEffect(() => {
    if (!opened || !asOf) return undefined;
    let cancelled = false;
    setPreview(null);
    setError('');
    client.documents
      .restore(documentId, asOf, { dryRun: true })
      .then((s) => {
        if (!cancelled) setPreview(s);
      })
      .catch((err) => {
        if (!cancelled) setError(restoreError(err, 'That state could not be read.'));
      });
    return () => {
      cancelled = true;
    };
  }, [opened, asOf, client, documentId]);

  const layers = indexLayers(raw);
  const lines = changeLines(preview, layers);
  const gaps = skippedLines(preview?.skipped);

  const close = () => {
    if (busy) return;
    onClose();
  };

  // Back to the state from just before the restore: itself a restore, to the
  // history entry that was newest when the restore began.
  const undo = (before) => {
    const run = client.documents.restore(
      documentId,
      before.time,
      {},
      historyMessage(before.time, before.label),
    );
    // The failure is already on screen as the toast, so swallow the rejection
    // rather than letting it surface a second time as an unhandled one.
    notifyPromise(
      run.finally(() => onRestoredRef.current?.()),
      {
        loading: 'Undoing the restore…',
        success: (res) =>
          res?.skipped?.length
            ? `Back to the state before the restore. ${skippedLines(res.skipped).join(' ')}`
            : 'Back to the state before the restore.',
        error: (err) => restoreError(err, 'The undo was not applied.'),
      },
    ).catch(() => {});
  };

  const restore = async () => {
    setBusy(true);
    try {
      const before = await latestState(client, documentId).catch(() => null);
      const res = await client.documents.restore(
        documentId,
        asOf,
        {},
        historyMessage(asOf, entry?.label),
      );
      const message = res?.skipped?.length
        ? skippedLines(res.skipped).join(' ')
        : `Restored to ${fullTimestamp(asOf)}.`;
      const title = res?.skipped?.length ? 'Restored, with gaps' : 'Restored';
      const color = res?.skipped?.length ? 'yellow' : 'green';
      if (before) {
        notifyWithAction(message, title, { label: 'Undo', onClick: () => undo(before), color });
      } else if (res?.skipped?.length) {
        notifyWarning(message, title);
      } else {
        notifySuccess(message, title);
      }
      onClose();
      await onRestored?.();
    } catch (err) {
      console.error('Restore failed:', err);
      notifyError(restoreError(err, 'The restore was not applied.'), 'Restore failed');
      await onRestored?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={`Restore to ${asOf ? fullTimestamp(asOf) : ''}`}
      size="md"
    >
      <Stack gap="sm">
        {entry?.label && (
          <Text size="sm" c="dimmed">
            {entry.label}
          </Text>
        )}

        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}

        {!error && !preview && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Comparing…
            </Text>
          </Group>
        )}

        {preview && lines.length === 0 && (
          <Text size="sm" c="dimmed">
            Nothing differs from the current state.
          </Text>
        )}

        {preview && lines.length > 0 && (
          <div>
            <Text size="sm" fw={500} mb={4}>
              Changes
            </Text>
            <List size="sm" withPadding>
              {lines.map((l) => (
                <List.Item key={l}>{l}</List.Item>
              ))}
            </List>
          </div>
        )}

        {gaps.length > 0 && (
          <List size="sm" withPadding c="red">
            {gaps.map((g) => (
              <List.Item key={g}>{g}</List.Item>
            ))}
          </List>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={restore}
            disabled={busy || !preview || lines.length === 0}
            loading={busy}
          >
            Restore
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
