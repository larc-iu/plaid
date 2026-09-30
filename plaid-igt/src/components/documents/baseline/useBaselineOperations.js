import { useState } from 'react';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { useEditLog } from '@ui/hooks/useEditLog.js';
import { notifySuccess } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';

// Baseline tab operations, backed by the shared IgtDocument. The box keeps
// its changes as edits made at the caret (plaid-ui's useEditLog), and the
// save (doc.editBaselineText) sends them as such, so each stands where it was
// typed. The hook owns the local editing state.
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
  const editLog = useEditLog();

  const handleEdit = () => {
    setEditedText(body);
    setBase(body);
    editLog.reset(body, primaryTextLayer?.text?.digest ?? null);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditedText('');
    setBase('');
    editLog.reset('');
    setIsEditing(false);
  };

  const handleSave = async () => {
    // Editing the baseline of an already-tokenized doc can delete or mis-align
    // existing tokens (and their annotations) in the changed/removed regions.
    // Text added at the end of the body leaves existing tokens untouched, so
    // only confirm otherwise. Read from the text, since a box filled whole
    // (a paste over everything) is one edit over the whole body even when it
    // only adds to the end.
    const gaps = editLog.gaps();
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
    const ok = await doc.editBaselineText({ base, digest: editLog.log.digest, gaps });
    setSaving(false);
    if (ok) {
      notifySuccess('Baseline text saved');
      setIsEditing(false);
    }
  };

  // Leaving the tab with text typed and not saved asks first: this tab holds
  // a whole document's baseline, and it used to go without a word. Not while
  // the save is on its way: it lands whether or not the tab is left.
  useUnsavedDraft(
    isEditing && !saving && editedText !== base ? 'The baseline text you have typed' : null,
  );

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

    handleEdit,
    handleCancel,
    handleSave,
    updateEditedText,
    handleTextChange,
    editLogHandlers: editLog.handlers,
  };
};
