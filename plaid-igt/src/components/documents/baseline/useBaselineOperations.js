import { useState } from 'react';
import { applyTextOps, gapsToOps } from '@larc-iu/plaid-client';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { useEditLog } from '@ui/hooks/useEditLog.js';
import { notifySuccess } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';

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

  const handleSave = async () => {
    // Editing the baseline of an already-tokenized doc can delete or mis-align
    // existing tokens (and their annotations) in the changed/removed regions.
    // Text added at the end of the body leaves existing tokens untouched, so
    // only confirm otherwise. Read from the text, since a box filled whole
    // (a paste over everything) is one edit over the whole body even when it
    // only adds to the end.
    const tokenized = (doc.layerInfo?.primaryTokenLayer?.tokens || []).length > 0;
    const risky = tokenized && editedText !== base && !editedText.startsWith(base);
    if (
      risky &&
      !(await confirm({
        title: 'Save baseline changes?',
        description:
          'This document is already tokenized. Editing the baseline text here can ' +
          'delete or mis-align existing tokens and the annotations on them in the changed or ' +
          'removed regions.',
        confirmLabel: 'Save anyway',
        destructive: true,
      }))
    ) {
      return;
    }
    setSaving(true);
    setChangedElsewhere(false);
    const sent = editLog.send();
    // What was sent, as the base of what is typed while it is on its way.
    setBase(shown(applyTextOps(sent.base, gapsToOps(sent.gaps))));
    const outcome = {};
    const ok = await doc.editBaselineText(sent, outcome);
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

  const updateEditedText = (text) => setEditedText(text);
  // The box's change, with the selection before it (editLogHandlers) and the
  // caret after it, kept as an edit.
  const handleTextChange = (event) => {
    editLog.onChange(event);
    setEditedText(event.target.value);
  };

  return {
    document: doc.document,
    project: doc.project,
    body,
    primaryTextLayer,
    isEditing,
    saving,
    editedText,
    changedElsewhere,

    handleEdit,
    handleCancel,
    handleSave,
    updateEditedText,
    handleTextChange,
    editLogHandlers: editLog.handlers,
  };
};
