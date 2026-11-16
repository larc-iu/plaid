import { OrthographiesManager } from '../settings/OrthographiesManager.jsx';

export const OrthographiesStep = ({ data, onDataChange }) => {
  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  // The Baseline and the list are drawn and worded as Settings draws them.
  // A listed orthography is made, so the note says so: without it a listed
  // IPA read as something that might or might not be switched on, and it
  // arrived as an empty row in the Analyze grid and a checked-but-empty line
  // in an export preset.
  return (
    <OrthographiesManager
      initialData={data}
      onSaveChanges={handleSaveChanges}
      autoSaveDefaults={true}
      note="Every orthography listed here is created. Remove the ones you do not want."
    />
  );
};

// Validation function for this step
OrthographiesStep.isValid = () => {
  // Always valid: additional orthographies are optional.
  return true;
};
