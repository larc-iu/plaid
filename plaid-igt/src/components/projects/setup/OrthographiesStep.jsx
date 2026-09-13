import { OrthographiesManager } from '../settings/OrthographiesManager.jsx';

export const OrthographiesStep = ({ data, onDataChange }) => {
  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          The <strong>Baseline</strong> is the text as you type it. Add other ways of writing each
          word beside it, such as an IPA transcription, another script, or a normalized spelling.
        </p>
        {/* This list has no on/off column, because a row IS the orthography.
            Without saying so, a listed IPA read as something that might or
            might not be switched on, and it arrived as an empty row in the
            Analyze grid and a checked-but-empty line in an export preset. */}
        <p className="mt-2 text-sm text-muted-foreground">
          Every orthography listed here is created. Remove the ones you do not want.
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
OrthographiesStep.isValid = () => {
  // Step is always valid - baseline orthography is always present
  // Having additional orthographies is optional
  return true;
};
