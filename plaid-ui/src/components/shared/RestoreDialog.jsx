// Restore a document to the state selected in the History drawer. The server
// does the work in one operation (documents.restore); the confirm step asks it
// for a dry run and lists what would change, in the linguist's terms, and the
// toast that confirms the restore offers Undo.
//
// What each app says differently is what it calls a token layer, so
// `roleWords` (role -> [singular, plural]) is a prop, and, for an app with
// layers of its own, `layerWords` (a layer's config -> [singular, plural], or
// null to leave it out; see `indexLayers`). Everything else, down to the
// wording of the toasts, is the same in every app.

import { useEffect, useRef, useState } from 'react';
import { readRole } from '@larc-iu/plaid-client';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import {
  changeLines,
  historyMessage,
  indexLayers,
  latestState,
  restoreError,
  skippedLines,
} from '../../domain/restoreSummary.js';
import {
  notifySuccess,
  notifyWarning,
  notifyError,
  notifyPromise,
  notifyWithAction,
} from '../../lib/notify.js';
import { fullTimestamp } from '../../lib/formatTime.js';

export const RestoreDialog = ({
  open,
  onOpenChange,
  client,
  documentId,
  raw,
  roleWords,
  layerWords,
  entry,
  onRestored,
}) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asOf = entry?.time ?? null;
  // The toast's Undo fires long after this render, so it reads the latest
  // callback rather than the one it closed over.
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

  const layers = indexLayers(raw, readRole, layerWords);
  const lines = changeLines(preview, layers, roleWords);
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
      const kind = res?.skipped?.length ? 'warning' : 'success';
      if (before) {
        notifyWithAction(message, title, { label: 'Undo', onClick: () => undo(before), kind });
      } else if (res?.skipped?.length) {
        notifyWarning(message, title);
      } else {
        notifySuccess(message, title);
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

        <div className="flex flex-col gap-3">
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
            <div>
              <p className="mb-1 text-sm font-medium">Changes</p>
              <ul className="ml-5 list-disc space-y-0.5 text-sm">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}

          {gaps.length > 0 && (
            <ul className="ml-5 list-disc space-y-0.5 text-sm text-destructive">
              {gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </div>

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
