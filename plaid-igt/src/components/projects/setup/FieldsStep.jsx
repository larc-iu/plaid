import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { FieldsManager } from '../settings/FieldsManager.jsx';

export const FieldsStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {

  // Seed defaults once, in an effect (NOT during render — calling the parent's
  // onDataChange mid-render warns "Cannot update a component while rendering a
  // different component"). Ref-guarded so it fires at most once.
  const didSeedRef = useRef(false);
  useEffect(() => {
    if (didSeedRef.current || data?.fields) return;
    didSeedRef.current = true;
    onDataChange({
      fields: [
        { name: 'Gloss', scope: 'Word', isCustom: false },
        { name: 'Translation', scope: 'Sentence', isCustom: false }
      ],
      ignoredTokens: {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: []
      }
    });
  }, [data, onDataChange]);

  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="tw flex flex-col gap-8">
      {/* Explanatory header. A <div> (not <p>) because Badge renders a <div>,
          which is invalid DOM nesting inside a <p>. */}
      <div>
        <div className="text-sm">
          Configure annotation fields for your project.{' '}
          <Badge variant="secondary" className="border-transparent bg-blue-100 text-blue-700">Word</Badge> scope fields apply to words,{' '}
          <Badge variant="secondary" className="border-transparent bg-violet-100 text-violet-700">Morpheme</Badge> scope fields apply to morphemes, and{' '}
          <Badge variant="secondary" className="border-transparent bg-green-100 text-green-700">Sentence</Badge> scope fields apply to entire sentences.
        </div>
      </div>

      {/* Use the reusable manager component */}
      <FieldsManager
        initialData={data}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
      />
    </div>
  );
};

// Validation function for this step
FieldsStep.isValid = (data) => {
  // Must have at least one annotation field
  return data?.fields && data.fields.length > 0;
};
