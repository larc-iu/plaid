import { useState } from 'react';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { notifySuccess } from '@/utils/feedback';

// Baseline tab operations, backed by the shared IgtDocument. The save itself
// (texts.update with server-side token shifting, plus the create/seed paths)
// lives in doc.saveBaselineText; the hook just owns the local editing state.
export const useBaselineOperations = () => {
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);

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
    if (risky && !window.confirm(
      'This document is already tokenized. Editing the baseline text here can delete or '
      + 'mis-align existing tokens and the annotations on them in the changed or removed '
      + 'regions. This cannot be undone. Save anyway?'
    )) {
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
