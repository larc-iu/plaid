import { useState } from 'react';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { notifySuccess } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';

// Baseline tab operations, backed by the shared IgtDocument. The save itself
// (texts.update with server-side token shifting, plus the create/seed paths)
// lives in doc.saveBaselineText; the hook just owns the local editing state.
export const useBaselineOperations = () => {
  const { doc } = useDocumentCtx();
  useDocumentModel(doc);
  const confirm = useConfirm();

  const body = doc.body || '';
  const primaryTextLayer = doc.layerInfo?.primaryTextLayer || null;

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedText, setEditedText] = useState('');

  const handleEdit = () => {
    setEditedText(body);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditedText('');
    setIsEditing(false);
  };

  const handleSave = async () => {
    // Editing the baseline of an already-tokenized doc can delete or mis-align
    // existing tokens (and their annotations) in the changed/removed regions —
    // the server re-diffs the text. A pure append (new text starts with the
    // current body) leaves existing tokens untouched, so only confirm otherwise.
    const tokenized = (doc.layerInfo?.primaryTokenLayer?.tokens || []).length > 0;
    const risky = tokenized && editedText !== body && !editedText.startsWith(body);
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
    const ok = await doc.saveBaselineText(editedText);
    setSaving(false);
    if (ok) {
      notifySuccess('Baseline text saved', 'Success');
      setIsEditing(false);
    }
  };

  // Leaving the tab with text typed and not saved asks first: this tab holds
  // a whole document's baseline, and it used to go without a word.
  useUnsavedDraft(isEditing && editedText !== body ? 'The baseline text you have typed' : null);

  const updateEditedText = (text) => setEditedText(text);

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
  };
};
