// Restore a document to the state selected in the History drawer. The
// confirm step shows what changes; the restore itself is one operation in
// the history, and the document is re-read and compared with the target
// afterwards, so the toast can say whether it landed exactly.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  notifySuccess,
  notifyWarning,
  notifyError,
  notifyPromise,
  humanizeError,
} from '@/utils/feedback';
import { previewRestore, runRestore, latestState } from '@/restore/restoreRunner';

const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`;
const formatTime = (t) => new Date(t).toLocaleString();

// The lines of the confirm step, one per kind of change.
const changeLines = (s) => {
  if (!s) return [];
  const lines = [];
  if (s.name) lines.push('The document name');
  if (s.text) lines.push('The text');
  if (s.sentences) lines.push(plural(s.sentences, 'sentence boundary', 'sentence boundaries'));
  if (s.words) lines.push(plural(s.words, 'word'));
  if (s.morphemes) lines.push(plural(s.morphemes, 'morpheme'));
  if (s.alignments) lines.push(plural(s.alignments, 'time alignment'));
  if (s.annotations) lines.push(plural(s.annotations, 'annotation'));
  if (s.links) lines.push(plural(s.links, 'vocabulary link'));
  if (s.metadata) lines.push('Metadata');
  return lines;
};

export const RestoreDialog = ({ open, onOpenChange, client, documentId, entry, onRestored }) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
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
    previewRestore({ client, documentId, asOf })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err) => {
        if (!cancelled) setError(humanizeError(err, 'That state could not be read.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, asOf, client, documentId]);

  const lines = changeLines(preview?.summary);
  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  // Back to the state from just before the restore: itself a restore, to the
  // history entry that was newest when the restore began.
  const undo = (before) => {
    const run = runRestore({ client, documentId, asOf: before.time, label: before.label });
    notifyPromise(
      run.finally(() => onRestoredRef.current?.()),
      {
        loading: 'Undoing the restore…',
        success: (res) =>
          res.exact && res.warnings.length === 0
            ? 'Back to the state before the restore.'
            : `Undone with differences. ${res.warnings.join(' ')}`.trim(),
        error: (err) =>
          humanizeError(err, 'The undo stopped partway. Restore that state again to finish.'),
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
      const res = await runRestore({
        client,
        documentId,
        asOf,
        label: entry?.label,
        onProgress: setPhase,
      });
      if (res.exact && res.warnings.length === 0) {
        notifySuccess(`Restored to ${formatTime(asOf)}.`, 'Restored', action);
      } else {
        notifyWarning(
          [
            res.exact
              ? null
              : `${plural(res.differences.length, 'difference')} from that state remain.`,
            ...res.warnings,
          ]
            .filter(Boolean)
            .join(' '),
          'Restored with differences',
          action,
        );
        if (!res.exact) console.warn('Restore differences:', res.differences);
      }
      onOpenChange(false);
      await onRestored?.();
    } catch (err) {
      console.error('Restore failed:', err);
      notifyError(
        humanizeError(err, 'The restore stopped partway. Restore again to finish.'),
        'Restore failed',
      );
      await onRestored?.();
    } finally {
      setBusy(false);
      setPhase('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restore to {asOf ? formatTime(asOf) : ''}</DialogTitle>
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
        <DialogFooter>
          {phase && (
            <span className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary" />
              {phase}
            </span>
          )}
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
