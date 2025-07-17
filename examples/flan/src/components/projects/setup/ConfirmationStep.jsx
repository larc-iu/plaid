import { Stack, Text } from '@mantine/core';

export const ConfirmationStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  return (
    <Stack spacing="lg">
      <Text>Confirmation Step - Coming Soon</Text>
      <Text size="sm" c="dimmed">
        This step will review all configuration and execute the setup.
      </Text>
    </Stack>
  );
};