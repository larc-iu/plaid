import { useState } from 'react';
import { applyTextOps, gapsToOps } from '@larc-iu/plaid-client';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { useEditLog } from '@ui/hooks/useEditLog.js';
import { notifyError, notifySuccess } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { countTextDeleteLoss, lossPhrase } from '@ui/domain/annotationLoss.js';
import { isTokenIgnored, readIgnoredTokens } from '@/domain/igtConfig';

// Baseline tab operations, backed by the shared IgtDocument. The box keeps
// its changes as edits made at the caret (plaid-ui's useEditLog), and the
// save (doc.editBaselineText) sends them as such, so each stands where it was
// typed. The hook owns the local editing state.
//
// The box stays open while a save is on its way. The log is split at the
// send: what is typed meanwhile is kept as edits of the text sent. When the
// save lands with nothing typed since, the tab leaves edit mode. Otherwise it
// stays in it, over the text stored, with what was typed since moved onto
// that text (or kept as typed when it cannot be). A save that is refused puts
// its edits back in front of what was typed since. One that landed and then
// failed at a step after it does not: its edits never come back into the
// draft, and what was typed since is moved onto the text stored, as after a
// save that landed. A save whose answer is lost is sent again until it is
// answered (the document's write queue), so it ends as one or the other.
//
// `changedElsewhere` is true while the draft cannot go onto the text stored
// because the same passage was changed elsewhere: a save refused for it, or
// text typed during a save that landed that cannot be moved onto it. It lasts
// until the next save or Cancel.
// Whether `gaps` (code points of `base`) take away any of its text. What a
// gap gives back at its front or end is not taken: a paste over the whole
// box that only adds to it is an insert.
export function removesText(base, gaps) {
  return removedStretches(base, gaps).length > 0;
}

// The stretches of `base` (code points, [begin, end)) that `gaps` take away:
// each gap's old text less what it gives back at its front and end.
export function removedStretches(base, gaps) {
  const cps = Array.from(base);
  return gaps.flatMap(({ start, end, value }) => {
    const old = cps.slice(start, end);
    const typed = Array.from(value);
    let front = 0;
    while (front < old.length && front < typed.length && old[front] === typed[front]) front += 1;
    let back = 0;
    while (
      back < old.length - front &&
      back < typed.length - front &&
      old[old.length - 1 - back] === typed[typed.length - 1 - back]
    ) {
      back += 1;
    }
    return front + back < old.length ? [[start + front, end - back]] : [];
  });
}

// What a save that takes away `ranges` deletes, as a sentence for its
// question, or '' when it deletes nothing: the shared loss counter's count of
// every token wholly inside a removed stretch and what hangs off it.
export function baselineLossSentence(doc, ranges) {
  const loss = countTextDeleteLoss(doc.layerInfo?.primaryTextLayer?.tokenLayers || [], ranges, {
    vocabLinks: Object.values(doc.vocabularies || {}).flatMap((v) => v?.vocabLinks || []),
  });
  const gone = lossPhrase(loss);
  const cut = lossPhrase(loss.shortened);
  return [gone && `Deletes ${gone}.`, cut && `Shortens ${cut}.`].filter(Boolean).join(' ');
}

// Does the document hold a word? A token the ignored-tokens rule excludes is
// text, not a word (punctuation ud's Tokenize made, say).
const hasWords = (doc) => {
  const layer = doc.layerInfo?.primaryTokenLayer;
  const cfg = readIgnoredTokens(layer?.config);
  const body = Array.from(doc.body || '');
  return (layer?.tokens || []).some(
    (t) => !isTokenIgnored(body.slice(t.begin, t.end).join(''), cfg),
  );
};

export const useBaselineOperations = () => {
  const { doc } = useDocumentCtx();
  useDocumentModel(doc);
  const confirm = useConfirm();

  const body = doc.body || '';
  const primaryTextLayer = doc.layerInfo?.primaryTextLayer || null;

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedText, setEditedText] = useState('');
  // The body the draft was typed over. A save moves the draft's changes onto
  // the body stored by then (see editBaselineText), so a passage someone else
  // saved meanwhile is not put back as it was here.
  const [base, setBase] = useState('');
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const editLog = useEditLog();

  const handleEdit = () => {
    setEditedText(body);
    setBase(body);
    editLog.reset(body, primaryTextLayer?.text?.digest ?? null);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setChangedElsewhere(false);
    setEditedText('');
    setBase('');
    editLog.reset('');
    setIsEditing(false);
  };

  // `text` as the box shows it: every line break a `\n`.
  const shown = (text) => text.replace(/\r\n?/g, '\n');

  // A throw anywhere in a save is reported and leaves the draft as it was,
  // so Save works again (rather than a button that does nothing).
  const handleSave = async () => {
    const at = { sent: null, settled: false };
    try {
      await save(at);
    } catch (err) {
      if (at.sent && !at.settled) {
        editLog.unsend(at.sent);
        setBase(base);
      }
      setSaving(false);
      notifyError(err, 'Failed to save baseline text');
    }
  };

  const save = async (at) => {
    // Nothing changed (or typed and taken back): nothing to send, and no
    // operation is written for it.
    if (editLog.gaps().length === 0 || editedText === base) {
      handleCancel();
      return;
    }
    // On a tokenized document, a save that deletes or replaces text can
    // delete tokens and the annotations on them, so it asks first. One that
    // only inserts, glued to a word or not, keeps every token (Luke,
    // 2026-10-16).
    const removed = hasWords(doc) ? removedStretches(editLog.log.base, editLog.gaps()) : [];
    if (
      removed.length > 0 &&
      !(await confirm({
        title: 'Save baseline changes?',
        description:
          baselineLossSentence(doc, removed) ||
          'Deletes or shortens words in the changed or removed text.',
        confirmLabel: 'Save anyway',
        destructive: true,
      }))
    ) {
      return;
    }
    setSaving(true);
    setChangedElsewhere(false);
    const sent = editLog.send();
    at.sent = sent;
    // What was sent, as the base of what is typed while it is on its way.
    setBase(shown(applyTextOps(sent.base, gapsToOps(sent.gaps))));
    const outcome = {};
    const ok = await doc.editBaselineText(sent, outcome);
    at.settled = true;
    setSaving(false);
    if (!ok && !outcome.landed) {
      editLog.unsend(sent);
      setBase(base);
      setChangedElsewhere(!!outcome.conflict);
      return;
    }
    if (ok) notifySuccess('Baseline text saved');
    if (editLog.gaps().length === 0) {
      handleCancel();
      return;
    }
    // Typed while the save was on its way: moved onto the text stored now,
    // which holds what was sent and what anyone else saved meanwhile.
    const stored = doc.body || '';
    const storedDigest = doc.layerInfo?.primaryTextLayer?.text?.digest ?? null;
    const moved = editLog.rebase(stored, storedDigest);
    if (moved.conflict) {
      setChangedElsewhere(true);
      return;
    }
    setBase(shown(stored));
    setEditedText(moved.body);
  };

  // Leaving the tab with text typed and not saved asks first: this tab holds
  // a whole document's baseline, and it used to go without a word. What a
  // save on its way sends is not asked about: it lands whether or not the tab
  // is left. What was typed since is.
  useUnsavedDraft(isEditing && editedText !== base ? 'The baseline text you have typed' : null);

  // The box's change, with the selection before it (editLogHandlers) and the
  // caret after it, kept as an edit.
  const handleTextChange = (event) => {
    editLog.onChange(event);
    setEditedText(event.target.value);
  };

  return {
    body,
    primaryTextLayer,
    isEditing,
    saving,
    editedText,
    changedElsewhere,

    handleEdit,
    handleCancel,
    handleSave,
    handleTextChange,
    editLogHandlers: editLog.handlers,
  };
};
