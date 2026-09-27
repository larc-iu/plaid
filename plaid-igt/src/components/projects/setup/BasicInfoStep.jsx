import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';

export const BasicInfoStep = ({ data, onDataChange }) => {
  const handleProjectNameChange = (event) => {
    onDataChange({
      ...data,
      projectName: event.currentTarget.value,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label>
          Project name <span className="text-destructive">*</span>
        </Label>
        <Input
          placeholder="Enter a name for your project"
          value={data?.projectName || ''}
          onChange={handleProjectNameChange}
        />
      </div>
    </div>
  );
};

// Validation function for this step
BasicInfoStep.isValid = (data) => {
  const projectName = data?.projectName || '';
  return projectName.trim().length > 0;
};
