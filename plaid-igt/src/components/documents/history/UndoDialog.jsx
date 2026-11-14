// Undo one History entry, from what it changed: in a document (its rows
// there, `scope.documentId`) or in a vocabulary (its entries and every link
// to them, `scope.vocabLayerId`). Core does the work in one operation
// (`client.audit.undo`). Opening the dialog asks it for a dry run first and
// lists what would be undone and what would be left, and why, before
// anything is written.
//
// Not optimistic, as a restore is not: it is a server facility that rewrites
// rows the page may not hold, so the page waits for it and then reads the
// document or the vocabulary again (`onUndone`). While it runs the dialog
// cannot be dismissed. The undo is itself an entry of History, which opens
// on what it changed and can be undone in turn.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { historyHref } from '@ui/hooks/useHistoryParam.js';
import { countOf } from '@ui/lib/plural.js';
import { notifyError, notifyInfo, notifySuccess, notifyWarning } from '@/utils/feedback';
import { isUnknownOutcome } from '@ui/lib/errors.js';
import {
  leftCounts,
  leftGroups,
  notUndoneLines,
  undoError,
  undoneLine,
  undoneToast,
} from '@/domain/undoSummary.js';

const UNKNOWN_UNDO =
  'The server did not answer. The undo may have been made. History shows whether it was.';

/**
 * `entry`: the History entry open (`{id, label, action}`). `place(row)`: where
 * a row left can be shown (`{key, label, to}`), or null. `tokenRows`: the
 * entry's token rows with the role of each (`[{id, role}]`), which name the
 * tokens undone. `vocabularies`: from a document's History, the vocabularies
 * (`[{id, name}]`) whose entries the entry changed. An undo of a document's
 * rows leaves entries as they are (a link to an entry a merge or a deletion
 * took needs it, and stays), so the dialog says where they are undone, with
 * every link to them: each vocabulary's History, at this entry.
 */
export const UndoDialog = ({
  open,
  onOpenChange,
  client,
  entry,
  scope,
  place,
  tokenRows,
  vocabularies = [],
  onUndone,
}) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped after a refused undo, which reads the page again: what would be
  // undone is asked again against what is now there.
  const [reread, setReread] = useState(0);
  const entryId = entry?.id ?? null;
  const { documentId, vocabLayerId } = scope;
  const onUndoneRef = useRef(onUndone);
  onUndoneRef.current = onUndone;

  useEffect(() => {
    if (!open || !entryId) return undefined;
    let cancelled = false;
    setPreview(null);
    setError('');
    client.audit
      .undo(entryId, { dryRun: true, documentId, vocabLayerId })
      .then((s) => {
        if (!cancelled) setPreview(s);
      })
      .catch((err) => {
        if (!cancelled) setError(undoError(err, 'Failed to read what would be undone.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, entryId, client, documentId, vocabLayerId, reread]);

  const line = preview ? undoneLine(preview, { tokenRows }) : '';
  const groups = preview ? leftGroups(preview, place) : [];
  // Core lists the first rows left only: past them, each group counts the
  // rows listed, and one line says how many more there are.
  const left = leftCounts(preview);
  const notUndone = preview ? notUndoneLines(preview) : [];
  const nothing = !!preview && !line;

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  const undo = async () => {
    setBusy(true);
    try {
      const res = await client.audit.undo(entryId, { documentId, vocabLayerId });
      const { title, message, undid } = undoneToast(res, { tokenRows });
      (undid ? notifySuccess : notifyInfo)(message, title);
      onOpenChange(false);
      await onUndoneRef.current?.();
    } catch (err) {
      console.error('Undo failed:', err);
      if (isUnknownOutcome(err)) {
        // No answer, even to the client's resends under the undo's key: it
        // may have been made. History, read again, shows whether it was. A
        // fresh dry run would read the undo's own writes as changed since.
        notifyWarning(UNKNOWN_UNDO, 'Not confirmed');
        onOpenChange(false);
        await onUndoneRef.current?.();
        return;
      }
      notifyError(undoError(err, 'The undo was not applied.'), 'Failed to undo');
      await onUndoneRef.current?.();
      setReread((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md" data-testid="undo-dialog">
        <DialogHeader>
          <DialogTitle>Undo this {entry?.action ? 'action' : 'entry'}?</DialogTitle>
        </DialogHeader>

        {/* Nothing in it leads away while the undo runs. */}
        <div className="flex flex-col gap-3" inert={busy || undefined}>
          {entry?.label && (
            <p className="text-sm text-muted-foreground" dir="auto">
              {entry.label}
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!error && !preview && <Loading label="Comparing…" className="p-0" />}

          {nothing && <p className="text-sm">Nothing to undo.</p>}

          {line && (
            <div>
              <p className="mb-1 text-sm font-medium">To undo</p>
              <p className="text-sm" data-testid="undo-line">
                {line}
              </p>
            </div>
          )}

          {groups.length > 0 && (
            <div data-testid="undo-left">
              <p className="mb-1 text-sm font-medium">
                Left as they are
                <span className="ms-2 font-normal tabular-nums text-muted-foreground">
                  {left.total.toLocaleString()}
                </span>
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {groups.map((g) => (
                  <li key={g.reason} data-reason={g.reason}>
                    <details>
                      <summary className="cursor-pointer">
                        {g.label}
                        <span className="ms-2 tabular-nums text-muted-foreground">
                          {left.unlisted
                            ? `${g.count.toLocaleString()} listed`
                            : g.count.toLocaleString()}
                        </span>
                      </summary>
                      <ul className="ms-5 mt-1 flex flex-col gap-0.5">
                        {g.places.map((p) => (
                          <li key={p.key ?? ''} data-place={p.key ?? ''}>
                            {p.to ? (
                              <Link to={p.to} className="font-text hover:underline" dir="auto">
                                {p.label}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">{p.label}</span>
                            )}
                            <span className="ms-2 tabular-nums text-muted-foreground">
                              {countOf(p.count, 'change')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
              {left.unlisted > 0 && (
                <p className="mt-1 text-sm text-muted-foreground" data-testid="undo-unlisted">
                  {left.unlisted.toLocaleString()} more not listed.
                </p>
              )}
            </div>
          )}

          {preview && vocabularies.length > 0 && (
            <p className="text-sm" data-testid="undo-entries-note">
              Lexicon entries are undone from the vocabulary’s History, with every link to them:{' '}
              {vocabularies.map((v, i) => (
                <span key={v.id}>
                  {i > 0 && ', '}
                  <Link
                    to={historyHref(`/vocabularies/${v.id}`, entryId)}
                    className="font-text text-primary hover:underline"
                    dir="auto"
                  >
                    {v.name || 'Vocabulary'}
                  </Link>
                </span>
              ))}
            </p>
          )}

          {notUndone.map((l) => (
            <p key={l} className="text-sm text-muted-foreground">
              {l}
            </p>
          ))}
        </div>

        <DialogFooter>
          {nothing || error ? (
            <Button variant="outline" onClick={close}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={undo} disabled={busy || !preview}>
                {busy ? 'Undoing…' : 'Undo'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
