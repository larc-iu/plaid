// Restore a document to the state selected in the History drawer. The
// server does the work in one operation (documents.restore); the confirm
// step asks it for a dry run and lists what would change, in the
// linguist's terms, and the toast that confirms the restore offers Undo.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import { notifySuccess, notifyWarning, notifyError, notifyPromise } from '@/utils/feedback';
import {
  changeLines,
  historyMessage,
  indexLayers,
  latestState,
  restoreError,
  skippedLines,
} from '@/domain/restoreSummary.js';
import { fullTimestamp } from '@ui/lib/formatTime.js';

export const RestoreDialog = ({
  open,
  onOpenChange,
  client,
  documentId,
  doc,
  entry,
  onRestored,
}) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asOf = entry?.time ?? null;
  // The toast's Undo fires long after the restore's render, so it reads the
  // latest callback rather than the one it closed over.
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;

  useEffect(() => {
    if (!open || !asOf) return undefined;
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
  }, [open, asOf, client, documentId]);

  const layers = indexLayers(doc?.raw);
  const lines = changeLines(preview, layers);
  const gaps = skippedLines(preview?.skipped);
  const close = () => {
    if (busy) return;
    onOpenChange(false);
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
    );
  };

  const restore = async () => {
    setBusy(true);
    try {
      const before = await latestState(client, documentId).catch(() => null);
      // The toast stays long enough to be acted on.
      const action = before
        ? { action: { label: 'Undo', onClick: () => undo(before) }, duration: 15000 }
        : {};
      const res = await client.documents.restore(
        documentId,
        asOf,
        {},
        historyMessage(asOf, entry?.label),
      );
      if (res?.skipped?.length) {
        notifyWarning(skippedLines(res.skipped).join(' '), 'Restored, with gaps', action);
      } else {
        notifySuccess(`Restored to ${fullTimestamp(asOf)}.`, 'Restored', action);
      }
      onOpenChange(false);
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
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restore to {asOf ? fullTimestamp(asOf) : ''}</DialogTitle>
        </DialogHeader>
        {entry?.label && <p className="text-sm text-muted-foreground">{entry.label}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && !preview && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary" />
            Comparing…
          </p>
        )}
        {preview && lines.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing differs from the current state.</p>
        )}
        {preview && lines.length > 0 && (
          <div className="text-sm">
            <p className="mb-1 font-medium">Changes</p>
            <ul className="list-disc pl-5">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        )}
        {gaps.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={restore} disabled={busy || !preview || lines.length === 0}>
            {busy ? 'Restoring…' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
