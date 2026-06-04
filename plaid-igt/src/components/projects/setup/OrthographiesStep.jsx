import { OrthographiesManager } from '../settings/OrthographiesManager.jsx';

export const OrthographiesStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {

  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="tw flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          Configure orthographic representations for your project. The <strong>Baseline</strong> orthography
          represents your token layer and cannot be removed. You can add additional orthographies like IPA,
          alternative writing systems, or normalized forms.
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
