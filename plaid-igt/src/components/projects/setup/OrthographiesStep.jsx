import { OrthographiesManager } from '../settings/OrthographiesManager.jsx';

export const OrthographiesStep = ({
  data,
  onDataChange,
  setupData,
  isNewProject,
  projectId,
  user,
  client,
}) => {
  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="tw flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          The <strong>Baseline</strong> is the text as you type it. Add other ways of writing each
          word beside it, such as an IPA transcription, another script, or a normalized spelling.
        </p>
      </div>

      {/* Use the reusable manager component */}
      <OrthographiesManager
        initialData={data}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
        autoSaveDefaults={true}
      />
    </div>
  );
};

// Validation function for this step
OrthographiesStep.isValid = (data) => {
  // Step is always valid - baseline orthography is always present
  // Having additional orthographies is optional
  return true;
};
