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
import {
  notifySuccess,
  notifyWarning,
  notifyError,
  notifyPromise,
  humanizeError,
} from '@/utils/feedback';
import { ROLES } from '@larc-iu/plaid-client';

const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`;
const formatTime = (t) => new Date(t).toLocaleString();
const changed = (c) => (c?.inserted ?? 0) + (c?.updated ?? 0) + (c?.deleted ?? 0);

const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['word', 'words'],
  [ROLES.MORPHEME]: ['morpheme', 'morphemes'],
  [ROLES.TIME_ALIGNMENT]: ['time alignment', 'time alignments'],
};

const SKIPPED_WORDS = {
  text: ['text', 'texts'],
  token: ['token', 'tokens'],
  span: ['annotation', 'annotations'],
  relation: ['relation', 'relations'],
  'vocab-link': ['vocabulary link', 'vocabulary links'],
};

// Every layer of the raw document by id, with what to call it.
const indexLayers = (raw) => {
  const out = {};
  for (const tl of raw?.textLayers || []) {
    for (const tkl of tl.tokenLayers || []) {
      out[tkl.id] = { name: tkl.name, role: tkl.config?.plaid?.role };
      for (const sl of tkl.spanLayers || []) {
        out[sl.id] = { name: sl.name };
        for (const rl of sl.relationLayers || []) out[rl.id] = { name: rl.name };
      }
    }
  }
  return out;
};

// The lines of the confirm step, one per kind of change.
const changeLines = (s, layers) => {
  if (!s) return [];
  const lines = [];
  if (s.name) lines.push('The document name');
  if (changed(s.texts)) lines.push('The text');
  for (const e of s.tokens?.byLayer || []) {
    const n = changed(e);
    if (!n) continue;
    const layer = layers[e.layerId];
    const words = TOKEN_ROLE_WORDS[layer?.role];
    lines.push(
      words ? plural(n, ...words) : `${plural(n, 'token')} in ${layer?.name ?? 'a layer'}`,
    );
  }
  for (const e of s.spans?.byLayer || []) {
    const n = changed(e);
    if (n) lines.push(`${plural(n, 'annotation')} in ${layers[e.layerId]?.name ?? 'a field'}`);
  }
  for (const e of s.relations?.byLayer || []) {
    const n = changed(e);
    if (n) lines.push(`${plural(n, 'relation')} in ${layers[e.layerId]?.name ?? 'a layer'}`);
  }
  if (changed(s.vocabLinks)) lines.push(plural(changed(s.vocabLinks), 'vocabulary link'));
  if (s.documentMetadata) lines.push('Metadata');
  return lines;
};

const skippedLines = (skipped) =>
  (skipped || []).map(
    (k) => `${plural(k.count, ...(SKIPPED_WORDS[k.kind] || ['item', 'items']))} cannot come back.`,
  );

const historyMessage = (asOf, label) =>
  `Restore to ${formatTime(asOf)}` + (label ? ` (after “${label}”)` : '');

// A 409 from the restore is the server saying the old state no longer fits
// a layer as it is now; anything else is the usual story.
const restoreError = (err, fallback) => {
  const m = String(err?.message || '');
  if (/no longer fits/.test(m))
    return m.replace(/^HTTP \d+\s*/, '').replace(/\s*at\s+https?:\/\/\S+/, '');
  return humanizeError(err, fallback);
};

// The document's newest history entry: the moment its live state belongs
// to and what that entry is called, or null for a document with no history.
// Read before a restore so the state before it can be brought back.
const latestState = async (client, documentId) => {
  const entries = await client.documents.audit(documentId);
  const last = entries?.[entries.length - 1];
  if (!last) return null;
  return {
    time: last.endTime || last.time,
    label: last.message || last.ops?.[0]?.description || null,
  };
};

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
        notifySuccess(`Restored to ${formatTime(asOf)}.`, 'Restored', action);
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
