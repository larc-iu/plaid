import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Title, Button, Group, Alert, Textarea, Center, Loader, CopyButton } from '@mantine/core';
import { IconCopy, IconCheck, IconDownload } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';

export const ExportEditor = () => {
  const { projectId, documentId } = useParams();
  const [doc, setDoc] = useState(null);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const { getClient, logout } = useAuth();

  useConlluDocument(doc);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const client = getClient();
      if (!client) { logout(); return; }
      try {
        setLoading(true);
        const [projectData, next] = await Promise.all([
          client.projects.get(projectId),
          ConlluDocument.load(client, projectId, documentId)
        ]);
        if (cancelled) return;
        setProject(projectData);
        setDoc(next);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) { logout(); return; }
        setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
        console.error('Error fetching data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  const conlluContent = doc ? doc.toConllu() : '';

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

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (!doc || !project) {
    return <Alert color="red">{loadError || 'Document or project not found'}</Alert>;
  }

  return (
    <>
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={doc.raw}
      />

      <Title order={3} mb="md">CoNLL-U Export</Title>

      {loadError && <Alert color="red" mb="md">{loadError}</Alert>}

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
