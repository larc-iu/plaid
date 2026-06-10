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
