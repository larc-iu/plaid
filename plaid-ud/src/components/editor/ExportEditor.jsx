import { Title, Button, Group, Textarea, CopyButton } from '@mantine/core';
import { IconCopy, IconCheck, IconDownload } from '@tabler/icons-react';
import { useDocumentEditor } from './useDocumentEditor.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export const ExportEditor = () => {
  // Project, document and the breadcrumbs/tab strip all come from
  // DocumentEditorShell, which guarantees both are loaded before this renders.
  const { doc, project } = useDocumentEditor();

  useDocumentTitle('Export', doc?.name, project?.name);

  const conlluContent = doc.toConllu();

  const handleDownload = () => {
    const blob = new Blob([conlluContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${doc?.name || 'document'}.conllu`;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Title order={3} mb="md">
        CoNLL-U Export
      </Title>

      <Group gap="sm" mb="md">
        <CopyButton value={conlluContent} timeout={2000}>
          {({ copied, copy }) => (
            <Button
              color={copied ? 'teal' : 'blue'}
              leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              onClick={copy}
            >
              {copied ? 'Copied!' : 'Copy to Clipboard'}
            </Button>
          )}
        </CopyButton>

        <Button color="green" leftSection={<IconDownload size={16} />} onClick={handleDownload}>
          Download .conllu
        </Button>
      </Group>

      <Textarea
        value={conlluContent}
        readOnly
        autosize
        minRows={20}
        styles={{
          input: {
            fontFamily: 'var(--mantine-font-family-monospace)',
            backgroundColor: 'var(--mantine-color-gray-0)',
          },
        }}
      />
    </>
  );
};
