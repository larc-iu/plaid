import { Link } from 'react-router-dom';
import { Container, Title, Text, Button, Group, Stack, Paper, Code } from '@mantine/core';

// "Access Tokens" tab: pointer to named API tokens (managed per-user on the
// profile page). Programmatic / external-service access to the API uses a named
// token, which is individually revocable and attributed by name in the audit
// log. The content is project-agnostic, so it doesn't fetch anything.
export const ProjectAccessTokens = ({ embedded = false }) => {
  const content = (
    <Paper withBorder radius="md">
      <Group px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
        <Title order={3} size="h4">API Access</Title>
      </Group>
      <Stack px="lg" py="md" gap="sm" align="flex-start">
        <Text size="sm" c="dimmed">
          To access the API programmatically from external services like parsers or scripts,
          create a named API token. Unlike your login session, a named token can be revoked
          individually and its name appears in the audit history, so machine-made changes are
          distinguishable from yours.
        </Text>
        <Button component={Link} to="/profile" color="gray">
          Manage API Tokens
        </Button>
        <Text size="xs" c="dimmed">
          Use a token to initialize a Python <Code>PlaidClient</Code> instance.
        </Text>
      </Stack>
    </Paper>
  );

  return embedded ? content : <Container size="lg" py="xl">{content}</Container>;
};
