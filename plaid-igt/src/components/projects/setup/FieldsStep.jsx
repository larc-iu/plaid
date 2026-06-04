import { Badge } from '@/components/ui/badge';
import { FieldsManager } from '../settings/FieldsManager.jsx';

export const FieldsStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {

  // Initialize data with defaults if not already present
  if (!data?.fields) {
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
  }

  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="tw flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          Configure annotation fields for your project.{' '}
          <Badge variant="secondary" className="border-transparent bg-blue-100 text-blue-700">Word</Badge> scope fields apply to words,{' '}
          <Badge variant="secondary" className="border-transparent bg-violet-100 text-violet-700">Morpheme</Badge> scope fields apply to morphemes, and{' '}
          <Badge variant="secondary" className="border-transparent bg-green-100 text-green-700">Sentence</Badge> scope fields apply to entire sentences.
        </p>
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
