import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const BasicInfoStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  const handleProjectNameChange = (event) => {
    onDataChange({
      ...data,
      projectName: event.currentTarget.value
    });
  };

  return (
    <div className="tw flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label>Project Name <span className="text-destructive">*</span></Label>
        <Input
          placeholder="Enter a name for your project"
          value={data?.projectName || ''}
          onChange={handleProjectNameChange}
        />
        <p className="text-xs text-muted-foreground">
          Choose a descriptive name for your linguistic annotation project
        </p>
      </div>
    </div>
  );
};

// Validation function for this step
BasicInfoStep.isValid = (data) => {
  const projectName = data?.projectName || '';
  return projectName.trim().length > 0;
};
