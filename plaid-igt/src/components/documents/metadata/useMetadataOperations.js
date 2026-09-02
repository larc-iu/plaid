import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { notifySuccess } from '@/utils/feedback';
import { readDocumentMetadata } from '@/domain/igtConfig';
import { readTagsets } from '@/domain/tagsets';
import { metadataIsValid } from './MetadataField.jsx';

// Metadata tab operations, backed by the shared IgtDocument. All transient
// editing state (isEditing / drafts / modal / spinners) is component-local;
// the domain model handles the save/delete + optimistic patch + error toast.
export const useMetadataOperations = () => {
  const navigate = useNavigate();
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);

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
    metadataValid: metadataIsValid(metadataFields, editedMetadata, tagsetFor, document.metadata),
    isEditing,
    saving,
    deleting,
    deleteModalOpen,
    editedName,
    editedMetadata,

    // Actions
    handleEdit,
    handleCancel,
    handleSave,
    handleDeleteClick,
    handleCloseDeleteModal,
    handleDelete,
    updateEditedName,
    updateEditedMetadata,
  };
};
