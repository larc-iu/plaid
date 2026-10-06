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
//
// `afterRestore` is what an app writes once a restore, or its Undo, has
// landed: a value its own writes keep in step that the restore brought back
// as it was. It runs before the restore's newest history entry is read, so
// the Undo does not take it for an edit made since. A failure there leaves
// the restore as it landed.

import { useEffect, useRef, useState } from 'react';
import { readRole } from '@larc-iu/plaid-client';
import { Loading } from './Loading.jsx';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import {
  changeGroups,
  historyMessage,
  indexLayers,
  latestState,
  recordingNote,
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
import { statusOf } from '../../lib/errors.js';
import { useConfirm } from './ConfirmProvider.jsx';

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
  afterRestore,
}) => {
  const [preview, setPreview] = useState(null);
  // The recording's changes since the chosen moment (the document's audit,
  // media operations only), or null until read or when it cannot be read.
  const [mediaEntries, setMediaEntries] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asOf = entry?.time ?? null;
  // The toast's Undo fires long after this render, so it reads the latest
  // callback rather than the one it closed over.
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  const afterRestoreRef = useRef(afterRestore);
  afterRestoreRef.current = afterRestore;
  const settle = async () => {
    try {
      await afterRestoreRef.current?.();
    } catch (err) {
      console.error('Writing after the restore failed:', err);
    }
  };

  // Bumped after a refused restore: that reloads the page, so the list of
  // changes is read again against what is now live.
  const [reread, setReread] = useState(0);

  useEffect(() => {
    if (!open || !asOf) return undefined;
    let cancelled = false;
    setPreview(null);
    setError('');
    setMediaEntries(null);
    Promise.resolve()
      .then(() =>
        client.documents.audit(documentId, asOf, undefined, ['media/upload', 'media/delete']),
      )
      .then((entries) => {
        if (!cancelled) setMediaEntries(entries || []);
      })
      .catch(() => {});
    const dryRun = () => client.documents.restore(documentId, asOf, { dryRun: true });
    // In strict mode the dry run carries the version this page last read, so
    // a stale page is refused with a 409, and asking again with the same
    // version is refused the same way. Reload the document first, once.
    dryRun()
      .catch(async (err) => {
        if (statusOf(err) !== 409 || cancelled) throw err;
        await onRestoredRef.current?.();
        if (cancelled) throw err;
        return dryRun();
      })
      .then((s) => {
        if (!cancelled) setPreview(s);
      })
      .catch((err) => {
        if (!cancelled) setError(restoreError(err, 'Failed to read that state.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, asOf, client, documentId, reread]);

  const confirm = useConfirm();
  const layers = indexLayers(raw, readRole, layerWords);
  const groups = changeGroups(preview, layers, roleWords);
  const recording = preview ? recordingNote(mediaEntries, asOf, !!raw?.mediaUrl) : null;
  const gaps = [...skippedLines(preview?.skipped), ...(recording?.gap ? [recording.gap] : [])];

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  // Back to the state from just before the restore: itself a restore, to the
  // history entry that was newest when the restore began. Anything written
  // between the restore and this click would go with it, so it asks first:
  // the toast stays on screen long enough for someone to type a word, press
  // Enter and then reach for Undo.
  const undo = async (before, after) => {
    const now = await latestState(client, documentId).catch(() => null);
    if (now && after && now.time !== after.time) {
      const ok = await confirm({
        title: 'Undo the restore?',
        description:
          'The document has been edited since the restore. Going back to the state before it takes those edits too.',
        confirmLabel: 'Undo the restore',
        destructive: true,
      });
      if (!ok) return;
    }
    const run = client.documents
      .restore(documentId, before.time, {}, historyMessage(before.time, before.label))
      .then(async (res) => {
        await settle();
        return res;
      });
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
      await settle();
      const message = res?.skipped?.length
        ? skippedLines(res.skipped).join(' ')
        : `Restored to ${fullTimestamp(asOf)}.`;
      const title = res?.skipped?.length ? 'Restored, with gaps' : 'Restored';
      const kind = res?.skipped?.length ? 'warning' : 'success';
      if (before) {
        // What the restore itself left as the newest entry: an undo compares
        // against it to see whether anything has been written since.
        const after = await latestState(client, documentId).catch(() => null);
        notifyWithAction(message, title, {
          label: 'Undo',
          onClick: () => undo(before, after),
          kind,
        });
      } else if (res?.skipped?.length) {
        notifyWarning(message, title);
      } else {
        notifySuccess(message, title);
      }
      onOpenChange(false);
      await onRestored?.();
    } catch (err) {
      console.error('Restore failed:', err);
      notifyError(restoreError(err, 'The restore was not applied.'), 'Failed to restore');
      await onRestored?.();
      setReread((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restore to {asOf ? fullTimestamp(asOf) : ''}?</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {entry?.label && <p className="text-sm text-muted-foreground">{entry.label}</p>}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!error && !preview && <Loading label="Comparing…" className="p-0" />}

          {preview && groups.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing differs from the current state.</p>
          )}

          {groups.map((g) => (
            <div key={g.heading}>
              <p className="mb-1 text-sm font-medium">{g.heading}</p>
              <ul className="ml-5 list-disc space-y-0.5 text-sm">
                {g.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          ))}

          {recording?.note && <p className="text-sm text-muted-foreground">{recording.note}</p>}

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
          <Button onClick={restore} disabled={busy || !preview || groups.length === 0}>
            {busy ? 'Restoring…' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
