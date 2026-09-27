// Put one entry back as it was at the moment the history rail shows. The
// server does it in one operation (`vocabLayers.restoreItem`). The confirm
// step asks it for a dry run and lists what changes, in the entry's own terms,
// and the toast that confirms the restore offers Undo.
//
// Undo of an entry the restore brought back is deleting it again, the app's
// own delete. Undo of a form or fields set back is another restore, to the
// moment just before the first.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { fullTimestamp } from '@ui/lib/formatTime.js';
import {
  notifyError,
  notifyPromise,
  notifySuccess,
  notifyWithAction,
  humanizeError,
} from '@/utils/feedback';
import { entryRestoreLines, entryRestoreMessage, latestVocabState } from '@/domain/vocabRestore';

export const EntryRestoreDialog = ({
  open,
  onOpenChange,
  client,
  vocabularyId,
  asOf,
  past,
  live,
  label,
  fields,
  onRestored,
}) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  // The toast's Undo fires long after this render.
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  const itemId = past?.id ?? null;

  useEffect(() => {
    if (!open || !asOf || !itemId) return undefined;
    let cancelled = false;
    setPreview(null);
    setError('');
    client.vocabLayers
      .restoreItem(vocabularyId, itemId, asOf, { dryRun: true })
      .then((s) => {
        if (!cancelled) setPreview(s);
      })
      .catch((err) => {
        if (!cancelled) setError(humanizeError(err, 'That state could not be read.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, asOf, itemId, client, vocabularyId]);

  const lines = entryRestoreLines(preview, past, live, fields);

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  // How many words and morphemes link the entry now: deleting it takes those
  // links with it. Null when it cannot be told (no project links the
  // vocabulary, or the query failed).
  const linkCount = async () => {
    try {
      const res = await client.query({
        where: [['link', '?l', { item: itemId }]],
        return: { group: [], aggregates: [['count']] },
      });
      return res?.results?.[0]?.[0] ?? 0;
    } catch {
      return null;
    }
  };

  const undo = async (before, after, inserted) => {
    const now = await latestVocabState(client, vocabularyId, itemId).catch(() => null);
    const edited = !!(now && after && now.id !== after.id);
    if (inserted) {
      const links = await linkCount();
      if (edited || links) {
        const ok = await confirm({
          title: `Delete “${label}” again?`,
          description: links
            ? `${links} ${links === 1 ? 'word or morpheme is' : 'words and morphemes are'} linked to it now. Their links are deleted too.`
            : 'It has been edited since the restore.',
          confirmLabel: 'Delete entry',
          destructive: true,
        });
        if (!ok) return;
      }
    } else if (edited) {
      const ok = await confirm({
        title: 'Undo the restore?',
        description: `“${label}” has been edited since the restore. Those edits are undone too.`,
        confirmLabel: 'Undo the restore',
        destructive: true,
      });
      if (!ok) return;
    }
    const run = inserted
      ? client.vocabItems.delete(itemId, `Delete entry “${label}”`)
      : client.vocabLayers.restoreItem(
          vocabularyId,
          itemId,
          before.time,
          {},
          entryRestoreMessage(label, before.time),
        );
    notifyPromise(
      run.finally(() => onRestoredRef.current?.()),
      {
        loading: 'Undoing the restore…',
        success: inserted ? `“${label}” deleted again.` : `“${label}” is back as it was.`,
        error: (err) => humanizeError(err, 'The undo was not applied.'),
      },
    ).catch(() => {});
  };

  const restore = async () => {
    setBusy(true);
    try {
      const before = await latestVocabState(client, vocabularyId, itemId).catch(() => null);
      const res = await client.vocabLayers.restoreItem(
        vocabularyId,
        itemId,
        asOf,
        {},
        entryRestoreMessage(label, asOf),
      );
      const message = res?.inserted
        ? `“${label}” is back, without its links.`
        : `“${label}” is as it was at ${fullTimestamp(asOf)}.`;
      const after = await latestVocabState(client, vocabularyId, itemId).catch(() => null);
      if (res?.inserted || before) {
        notifyWithAction(message, 'Restored', {
          label: 'Undo',
          onClick: () => undo(before, after, !!res?.inserted),
          kind: 'success',
        });
      } else {
        notifySuccess(message, 'Restored');
      }
      onOpenChange(false);
      await onRestored?.();
    } catch (err) {
      console.error('Entry restore failed:', err);
      notifyError(humanizeError(err, 'The restore was not applied.'), 'Failed to restore');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle dir="auto">Restore “{label}”?</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">As of {fullTimestamp(asOf)}</p>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!error && !preview && <Loading label="Comparing…" className="p-0" />}

          {preview && lines.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing differs from the current entry.</p>
          )}

          {preview && lines.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium">Changes</p>
              <ul className="ml-5 list-disc space-y-0.5 text-sm">
                {lines.map((l) => (
                  <li key={l} dir="auto">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
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
