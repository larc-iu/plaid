import Editor from 'react-simple-code-editor';
import { Stack, Box, Group, Button, Alert, Code } from '@mantine/core';
import { IconSearch, IconAlertTriangle } from '@tabler/icons-react';
import { highlightGrew } from './grewSyntax.js';

// The query editor: a syntax-highlighted code box (react-simple-code-editor +
// our tolerant Grew highlighter) + Run, plus an inline error panel. Parse/
// compile errors render here with a caret; server errors render as a message.
export const GrewQueryInput = ({ value, onChange, onRun, running, error }) => {
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onRun(); }
  };

  return (
    <Stack gap="xs">
      <Box
        style={{
          border: '1px solid var(--mantine-color-gray-4)',
          borderRadius: 'var(--mantine-radius-sm)',
          background: 'var(--mantine-color-body)',
          overflow: 'auto',
          maxHeight: 280,
        }}
      >
        <Editor
          value={value}
          onValueChange={onChange}
          highlight={highlightGrew}
          onKeyDown={onKeyDown}
          padding={10}
          textareaId="grew-query"
          placeholder={'pattern { X [upos=VERB]; Y [upos=NOUN]; X -[nsubj]-> Y }'}
          spellCheck={false}
          style={{
            fontFamily: 'var(--mantine-font-family-monospace)',
            fontSize: 13,
            lineHeight: 1.5,
            minHeight: 72,
          }}
        />
      </Box>
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
