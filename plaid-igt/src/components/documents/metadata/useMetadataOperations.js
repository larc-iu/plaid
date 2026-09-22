import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useUnsavedGuard, dropUnsavedDrafts } from '@ui/hooks/useUnsavedDraft.js';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { notifySuccess } from '@/utils/feedback';
import { readDocumentMetadata } from '@/domain/igtConfig';
import { readTagsets } from '@/domain/tagsets';
import { changedValuesAllowed } from '@/domain/tagsets';

// Metadata tab operations, backed by the shared IgtDocument. All transient
// editing state (isEditing / drafts / modal / spinners) is component-local;
// the domain model handles the save/delete + optimistic patch + error toast.
export const useMetadataOperations = () => {
  const navigate = useNavigate();
  const { doc } = useDocumentCtx();
  useDocumentModel(doc);

  const document = doc.document;
  const project = doc.project;
  const metadataFields = readDocumentMetadata(project?.config) || [];
  // A metadata field names its tagset the same way an annotation field does.
  const tagsets = readTagsets(project?.config);
  const tagsetFor = (field) => (field?.tagset ? (tagsets[field.tagset] ?? null) : null);

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [copyModalOpen, setCopyModalOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyName, setCopyName] = useState('');
  const [editedName, setEditedName] = useState('');
  const [editedMetadata, setEditedMetadata] = useState({});

  const handleEdit = () => {
    setEditedName(document.name || '');
    const initialMetadata = {};
    metadataFields.forEach((field) => {
      initialMetadata[field.name] = document.metadata[field.name] || '';
    });
    setEditedMetadata(initialMetadata);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditedName('');
    setEditedMetadata({});
    setIsEditing(false);
  };

  const handleSave = async () => {
    setSaving(true);
    // saveNameAndMetadata merges the partial over existing raw metadata (so
    // deactivated fields aren't dropped) and handles errors + optimistic patch.
    const ok = await doc.saveNameAndMetadata(editedName, editedMetadata);
    setSaving(false);
    if (ok) setIsEditing(false);
  };

  // The same for this tab's own drafts: the name and the fields being edited.
  const nameChanged = isEditing && editedName !== (document.name || '');
  const fieldsChanged =
    isEditing &&
    metadataFields.some(
      (field) => (editedMetadata[field.name] ?? '') !== (document.metadata[field.name] || ''),
    );
  useUnsavedDraft(nameChanged || fieldsChanged ? 'What you have typed here' : null);
  // The two ways this tab leaves itself. A router push is none of the ways out
  // the hook watches, so it asks here.
  const guardLeaving = useUnsavedGuard();

  const handleCopyClick = () => {
    setCopyName(`${document.name || ''} (copy)`);
    setCopyModalOpen(true);
  };
  const handleCloseCopyModal = () => setCopyModalOpen(false);

  const handleCopy = async () => {
    setCopying(true);
    const name = copyName.trim();
    const newId = await doc.copyDocument(name);
    setCopying(false);
    if (newId) {
      setCopyModalOpen(false);
      notifySuccess(`"${name}" is ready.`, 'Document copied');
      // The copy is made either way; what is asked about is LEAVING this
      // screen for it, because what is typed here goes with the screen.
      if (!(await guardLeaving())) return;
      navigate(`/projects/${doc.projectId}/documents/${newId}`);
    }
  };

  const handleDeleteClick = () => setDeleteModalOpen(true);
  const handleCloseDeleteModal = () => setDeleteModalOpen(false);

  const handleDelete = async () => {
    setDeleting(true);
    const name = document.name;
    const ok = await doc.deleteDocument();
    setDeleting(false);
    setDeleteModalOpen(false);
    if (ok) {
      notifySuccess(`"${name}" has been successfully deleted.`, 'Document deleted');
      // Nothing to ask: the document what was typed belonged to is gone. The
      // extra history entry still comes out before the route changes.
      await dropUnsavedDrafts();
      navigate(`/projects/${doc.projectId}`);
    }
  };

  const updateEditedName = (name) => setEditedName(name);
  const updateEditedMetadata = (fieldName, value) =>
    setEditedMetadata((prev) => ({ ...prev, [fieldName]: value }));

  return {
    // State
    document,
    project,
    metadataFields,
    tagsetFor,
    // Save is blocked while a governed field holds a value its tagset refuses.
    // The form has no per-field commit, so this is where the rule can bite.
    metadataValid: changedValuesAllowed(
      metadataFields,
      editedMetadata,
      tagsetFor,
      document.metadata,
    ),
    isEditing,
    saving,
    deleting,
    deleteModalOpen,
    copying,
    copyModalOpen,
    copyName,
    editedName,
    editedMetadata,

    // Actions
    handleEdit,
    handleCancel,
    handleSave,
    handleDeleteClick,
    handleCloseDeleteModal,
    handleDelete,
    handleCopyClick,
    handleCloseCopyModal,
    handleCopy,
    updateCopyName: setCopyName,
    updateEditedName,
    updateEditedMetadata,
  };
};
