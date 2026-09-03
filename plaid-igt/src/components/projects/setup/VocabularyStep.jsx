import { VocabularyManager } from '../settings/VocabularyManager.jsx';

export const VocabularyStep = ({
  data,
  onDataChange,
  setupData,
  isNewProject,
  projectId,
  user,
  client,
}) => {
  // Load vocabularies from API on mount
  const handleLoadData = async () => {
    try {
      if (!client) throw new Error('Not authenticated');

      const vocabList = await client.vocabLayers.list();

      // Transform API vocabs into our format
      const initialVocabs = (vocabList || []).map((vocab) => ({
        name: vocab.name || vocab.id,
        id: vocab.id,
        enabled: false, // Default to disabled
        isCustom: false, // Existing vocabs from API
      }));

      return { vocabularies: initialVocabs };
    } catch (err) {
      console.error('Error fetching vocabularies:', err);
      throw err;
    }
  };

  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="tw flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          A vocabulary is a shared lexicon. Link words and morphemes to its entries so the same item
          is glossed the same way everywhere, in this project and in others that share it.
        </p>
      </div>

      {/* Use the reusable manager component */}
      <VocabularyManager
        initialData={data}
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
        isSettings={false}
      />
    </div>
  );
};

// Validation function for this step
VocabularyStep.isValid = (data) => {
  // Step is always valid - vocabularies are optional
  // Users can proceed without any vocabularies if they don't need this feature
  return true;
};
