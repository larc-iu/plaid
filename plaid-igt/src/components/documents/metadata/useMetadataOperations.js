import { useState } from 'react';
import { isReservedMetadataKey } from '@larc-iu/plaid-client';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { readDocumentMetadata } from '@/domain/igtConfig';
import { readTagsets, changedValuesAllowed } from '@/domain/tagsets';

// The project's document fields on the Details tab (Date, Speakers, and
// whatever else a maintainer declared), backed by the shared IgtDocument. The
// name, the copy and the delete are the shared Details page's. What is typed
// here and not saved is this hook's, and Save writes only the fields it
// changed, so a value someone else saved to another field meanwhile stays.
export const useMetadataOperations = (doc) => {
  useDocumentModel(doc);

  const stored = doc.document?.metadata || {};
  const project = doc.project;
  // `plaid` and the provenance keys are Plaid's own, never a field's value.
  const metadataFields = (readDocumentMetadata(project?.config) || []).filter(
    (field) => !isReservedMetadataKey(field.name),
  );
  // A metadata field names its tagset the same way an annotation field does.
  const tagsets = readTagsets(project?.config);
  const tagsetFor = (field) => (field?.tagset ? (tagsets[field.tagset] ?? null) : null);

  // Only the fields typed in. The rest show what is stored, so a value saved
  // from elsewhere shows as soon as it lands.
  const [edited, setEdited] = useState({});
  const [saving, setSaving] = useState(false);

  const values = Object.fromEntries(
    metadataFields.map((field) => [field.name, edited[field.name] ?? stored[field.name] ?? '']),
  );
  const dirty = metadataFields.some((field) => values[field.name] !== (stored[field.name] ?? ''));
  useUnsavedDraft(dirty ? 'What you have typed here' : null);

  const updateValue = (name, value) => setEdited((prev) => ({ ...prev, [name]: value }));

  const handleSave = async () => {
    setSaving(true);
    // The name is the shared page's, so none is passed. The fields left as
    // they were are not written.
    const ok = await doc.saveNameAndMetadata(null, values);
    setSaving(false);
    if (ok) setEdited({});
  };

  return {
    metadataFields,
    tagsetFor,
    values,
    dirty,
    // Save is blocked while a governed field holds a value its tagset refuses.
    // The fields have no commit of their own, so this is where the rule bites.
    metadataValid: changedValuesAllowed(metadataFields, values, tagsetFor, stored),
    saving,
    updateValue,
    handleSave,
  };
};
