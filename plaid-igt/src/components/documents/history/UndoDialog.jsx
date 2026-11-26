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
import { notifyError, notifyInfo, notifySuccess, notifyWarning } from '@/utils/feedback';
import { isUnknownOutcome } from '@ui/lib/errors.js';
import { IsolatedLabel } from '@ui/components/shared/IsolatedLabel.jsx';
import {
  leftCounts,
  leftGroups,
  leftLine,
  notUndoneLines,
  undoError,
  undoneLine,
  undoneToast,
} from '@/domain/undoSummary.js';
import { t, tx, msg } from '@ui/lib/i18n.js';

const UNKNOWN_UNDO = msg(
  'The server did not answer. The undo may have been made. History shows whether it was.',
);

/**
 * `entry`: the History entry open (`{id, label, action, ref}`). `place(row)`: where
 * a row left can be shown (`{key, label, to}`), or null. `tokenRows`: the
 * entry's token rows with the role of each (`[{id, role}]`), which name the
 * tokens undone. `vocabularies`: from a document's History, the vocabularies
 * (`[{id, name}]`) whose entries the entry changed. An undo of a document's
 * rows leaves entries as they are (a link to an entry a merge or a deletion
 * took needs it, and stays), so the dialog says where they are undone, with
 * every link to them: each vocabulary's History, at this entry.
 *
 * `send({dryRun})`, where it is not one entry's undo through `scope` (a job's
 * undo), and `title`, the dialog's question ("Undo this job?"). `noun`, what
 * the title calls it ("job"), is the older way, in English only. `tokens`, with no
 * `tokenRows`, says what the tokens are (undoneLine). `errorText(err,
 * fallback)` words a refusal, undoError by default. `onUndone(summary)` is
 * called after the undo, with core's answer, or with null when it is not
 * known whether the undo was made.
 */
export const UndoDialog = ({
  open,
  onOpenChange,
  client,
  entry,
  scope = {},
  send,
  title,
  noun,
  errorText = undoError,
  place,
  tokenRows,
  tokens,
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
  const sendRef = useRef(null);
  sendRef.current =
    send ??
    (({ dryRun }) =>
      client.audit.undo(entryId, { dryRun: dryRun || undefined, documentId, vocabLayerId }));
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;

  useEffect(() => {
    if (!open || !entryId) return undefined;
    let cancelled = false;
    setPreview(null);
    setError('');
    sendRef
      .current({ dryRun: true })
      .then((s) => {
        if (!cancelled) setPreview(s);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errorTextRef.current(err, t('Failed to read what would be undone.')));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, entryId, client, documentId, vocabLayerId, reread]);

  const line = preview ? undoneLine(preview, { tokenRows, tokens }) : '';
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
      const res = await sendRef.current({ dryRun: false });
      const { title, message, undid } = undoneToast(res, { tokenRows, tokens });
      (undid ? notifySuccess : notifyInfo)(message, title);
      onOpenChange(false);
      await onUndoneRef.current?.(res);
    } catch (err) {
      console.error('Undo failed:', err);
      if (isUnknownOutcome(err)) {
        // No answer, even to the client's resends under the undo's key: it
        // may have been made. History, read again, shows whether it was. A
        // fresh dry run would read the undo's own writes as changed since.
        notifyWarning(t(UNKNOWN_UNDO), t('Not confirmed'));
        onOpenChange(false);
        await onUndoneRef.current?.(null);
        return;
      }
      notifyError(errorTextRef.current(err, t('The undo was not applied.')), t('Failed to undo'));
      await onUndoneRef.current?.(null);
      setReread((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md" data-testid="undo-dialog">
        <DialogHeader>
          <DialogTitle>
            {title ??
              (noun
                ? `Undo this ${noun}?` // i18n-ignore the old bare-noun prop, English only: callers pass `title`
                : entry?.action
                  ? t('Undo this action?')
                  : t('Undo this entry?'))}
          </DialogTitle>
        </DialogHeader>

        {/* Nothing in it leads away while the undo runs. */}
        <div className="flex flex-col gap-3" inert={busy || undefined}>
          {entry?.label && (
            <p className="text-sm text-muted-foreground" dir="auto">
              <IsolatedLabel label={entry.label} />
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!error && !preview && <Loading label={t('Comparing…')} className="p-0" />}

          {nothing && <p className="text-sm">{t('Nothing to undo.')}</p>}

          {line && (
            <div>
              <p className="mb-1 text-sm font-medium">{t('To undo')}</p>
              <p className="text-sm" data-testid="undo-line">
                {line}
              </p>
            </div>
          )}

          {groups.length > 0 && (
            <div data-testid="undo-left">
              <p className="mb-1 text-sm font-medium">
                {t('Left as they are')}
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
                            ? t('{n, number} listed', { n: g.count })
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
                              {leftLine(
                                (preview.skipped || []).filter(
                                  (r) => r.reason === g.reason && (place(r)?.key ?? null) === p.key,
                                ),
                                { tokenRows, tokens },
                              )}
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
                  {t('{n, number} more not listed.', { n: left.unlisted })}
                </p>
              )}
            </div>
          )}

          {preview && vocabularies.length > 0 && (
            <p className="text-sm" data-testid="undo-entries-note">
              {tx(
                'Lexicon entries are undone from the vocabulary’s History, with every link to them: {vocabularies}',
                {
                  vocabularies: (
                    <>
                      {vocabularies.map((v, i) => (
                        <span key={v.id}>
                          {i > 0 && ', '}
                          <Link
                            to={historyHref(`/vocabularies/${v.id}`, entryId)}
                            className="font-text text-primary hover:underline"
                            dir="auto"
                          >
                            {v.name || t('Vocabulary')}
                          </Link>
                        </span>
                      ))}
                    </>
                  ),
                },
              )}
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
              {t('Close')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={busy}>
                {t('Cancel')}
              </Button>
              <Button onClick={undo} disabled={busy || !preview}>
                {busy ? t('Undoing…') : t('Undo')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
