import { Stack, TextInput, Text } from '@mantine/core';

export const BasicInfoStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  const handleProjectNameChange = (event) => {
    onDataChange({
      ...data,
      projectName: event.currentTarget.value
    });
  };

  return (
    <Stack spacing="lg">
      <TextInput
        label="Project Name"
        placeholder="Enter a name for your project"
        value={data?.projectName || ''}
        onChange={handleProjectNameChange}
        required
        description="Choose a descriptive name for your linguistic annotation project"
      />
    </Stack>
  );
};

// Validation function for this step
BasicInfoStep.isValid = (data) => {
  const projectName = data?.projectName || '';
  return projectName.trim().length > 0;
};