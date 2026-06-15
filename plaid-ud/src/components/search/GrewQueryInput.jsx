import { Stack, Textarea, Group, Button, Alert, Code } from '@mantine/core';
import { IconSearch, IconAlertTriangle } from '@tabler/icons-react';

// The query editor: a monospace textarea + Run, plus an inline error panel.
// Parse/compile errors (GrewParseError / GrewUnsupportedError) render here with
// a caret pointing at the offending line; server errors render as a message.
export const GrewQueryInput = ({ value, onChange, onRun, running, error }) => {
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onRun(); }
  };

  return (
    <Stack gap="xs">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={'pattern { X [upos=VERB]; Y [upos=NOUN]; X -[nsubj]-> Y }'}
        autosize
        minRows={3}
        maxRows={12}
        spellCheck={false}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
      />
      <Group justify="space-between">
        <Button onClick={onRun} loading={running} leftSection={<IconSearch size={16} />}>
          Search
        </Button>
      </Group>
      {error && <QueryError error={error} />}
    </Stack>
  );
};

function QueryError({ error }) {
  const isUnsupported = error.name === 'GrewUnsupportedError';
  const title = error.name === 'GrewParseError'
    ? `Syntax error${error.line ? ` (line ${error.line})` : ''}`
    : isUnsupported
      ? 'Unsupported feature'
      : 'Search failed';
  return (
    <Alert color={isUnsupported ? 'yellow' : 'red'} icon={<IconAlertTriangle size={16} />} title={title}>
      <Stack gap={4}>
        <span>{error.message}</span>
        {error.name === 'GrewParseError' && error.sourceLine != null && (
          <Code block style={{ fontSize: 12 }}>
            {error.sourceLine}{'\n'}{' '.repeat(Math.max(0, (error.col || 1) - 1))}^
          </Code>
        )}
      </Stack>
    </Alert>
  );
}
