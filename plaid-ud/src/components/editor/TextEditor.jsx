import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  SimpleGrid, Stack, Title, Textarea, Button, Group, Text, Alert, Paper, Center, Loader,
} from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { missingUdLayerLabels } from '../../utils/udLayerUtils.js';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { confirmDelete } from '../../utils/feedback.jsx';
import { TokenVisualizer } from './TokenVisualizer.jsx';
import { DocumentTabs } from './DocumentTabs.jsx';

export const TextEditor = () => {
  const { projectId, documentId } = useParams();
  const [doc, setDoc] = useState(null);
  const [project, setProject] = useState(null);
  const [textContent, setTextContent] = useState('');
  const [originalTokenizedText, setOriginalTokenizedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lastSaved, setLastSaved] = useState(null);
  const { getClient } = useAuth();

  // Subscribe the component to the doc's version counter so any mutation
  // (sentences/words/morphemes/spans/relations + isSaving + error) triggers
  // a re-render.
  useConlluDocument(doc);

  const fetchData = async (initial) => {
    const client = getClient();
    if (!client) {
      window.location.href = '/login';
      return;
    }
    try {
      if (initial) setLoading(true);
      const [projectData, documentData] = await Promise.all([
        client.projects.get(projectId),
        client.documents.get(documentId, true)
      ]);
      setProject(projectData);
      const next = new ConlluDocument({ raw: documentData, client, projectId });
      setDoc(next);
      const text = next.layerInfo.textLayer?.text;
      if (text?.body) {
        setTextContent(text.body);
        const info = next.layerInfo;
        const hasTokens = (info.sentenceTokenLayer?.tokens || []).length > 0
          || (info.wordTokenLayer?.tokens || []).length > 0;
        if (hasTokens && !originalTokenizedText) {
          setOriginalTokenizedText(text.body);
        }
      }
      setLoadError('');
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  // --- thin wrappers around doc methods, kept for the bits that need to
  // poke TextEditor-local state (originalTokenizedText, lastSaved, etc.). ---

  const handleSaveText = async () => {
    if (!doc) return;
    if (!textContent.trim() || doc.isSaving) return;
    const ok = await doc.saveText(textContent);
    if (ok) {
      setLastSaved(new Date());
      setOriginalTokenizedText(textContent);
    }
  };

  const handleTextChange = (e) => {
    setTextContent(e.target.value);
    if (lastSaved) setLastSaved(null);
  };

  const handleTokenize = async () => {
    if (!doc) return;
    const ok = await doc.tokenize(textContent);
    if (ok) setOriginalTokenizedText(textContent);
  };

  const handleClearTokens = () => {
    if (!doc) return;
    confirmDelete({
      title: 'Clear all tokens',
      message: 'Are you sure you want to clear all tokens? This action cannot be undone.',
      confirmLabel: 'Clear',
      onConfirm: async () => {
        const ok = await doc.clearTokens();
        if (ok) setOriginalTokenizedText('');
      },
    });
  };

  const handleWordCreate = async (begin, end) => {
    if (!doc) return;
    const ok = await doc.createWord(begin, end, textContent);
    // After the very first manual creation, treat the current text as the
    // tokenized baseline (mirrors tokenize) so the dirty banner doesn't fire
    // just because tokens now exist.
    if (ok && !originalTokenizedText) setOriginalTokenizedText(textContent);
  };

  const handleWordUpdate = (wordId, begin, end) => doc?.updateWord(wordId, begin, end);
  const handleWordDelete = (wordId) => doc?.deleteWord(wordId);
  const handleSentenceBoundaryToggle = (charPos) => doc?.toggleSentenceBoundary(charPos);
  const handleSetWordMorphemes = (word, forms) => doc?.setWordMorphemes(word, forms);

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (loadError) {
    return <Alert color="red">{loadError}</Alert>;
  }

  if (!doc || !project) {
    return <Alert color="red">Document or project not found</Alert>;
  }

  const layerInfo = doc.layerInfo;
  const sentenceTokens = layerInfo.sentenceTokenLayer?.tokens || [];
  const wordTokens = layerInfo.wordTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo.morphemeTokenLayer?.tokens || [];

  // morpheme id -> Form span value (overrides text substring for display).
  const morphemeForms = new Map();
  (layerInfo.formLayer?.spans || []).forEach(span => {
    const tokenId = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
    if (tokenId != null && span.value != null) morphemeForms.set(tokenId, span.value);
  });

  const isTextDirty = originalTokenizedText && textContent !== originalTokenizedText;
  const hasTokens = sentenceTokens.length > 0 || wordTokens.length > 0 || morphemeTokens.length > 0;
  const saving = doc.isSaving;
  const opError = doc.error;

  // Project-level misconfig: the three token layers exist but their
  // overlap-mode / parent chain doesn't match the UD layout. Runtime
  // validation (not legacy detection) — applies regardless of how the data
  // got there.
  const layersMisconfigured = Boolean(
    layerInfo.isConfigured &&
    layerInfo.sentenceTokenLayer && layerInfo.wordTokenLayer && layerInfo.morphemeTokenLayer &&
    (layerInfo.sentenceTokenLayer.overlapMode !== 'partitioning' ||
     layerInfo.wordTokenLayer.overlapMode !== 'non-overlapping' ||
     layerInfo.wordTokenLayer.parentTokenLayer !== layerInfo.sentenceTokenLayer.id ||
     layerInfo.morphemeTokenLayer.parentTokenLayer !== layerInfo.wordTokenLayer.id)
  );

  const missingLayerLabels = !layerInfo.isConfigured
    ? missingUdLayerLabels(layerInfo.missingLayers)
    : [];

  return (
    <>
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={doc.raw}
      />

      {opError && <Alert color="red" mb="sm">{opError}</Alert>}

      {missingLayerLabels.length > 0 && (
        <Alert color="yellow" mb="sm">
          Project configuration incomplete: {missingLayerLabels.join(', ')}.
        </Alert>
      )}

      {layersMisconfigured && (
        <Alert color="yellow" mb="sm">
          This project's token layers are missing their overlap-mode / parent
          configuration (likely created with an older client bundle). Tokenization
          will still work, but server-enforced nesting and partitioning won't.
          Consider recreating the project.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl">
        <Stack gap="md">
          <Title order={4}>Text Content</Title>
          <Textarea
            value={textContent}
            onChange={handleTextChange}
            placeholder={`Enter your text here. Use newlines to separate sentences.

Example:
The quick brown fox jumps over the lazy dog.
This is a second sentence for testing.`}
            autosize
            minRows={12}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', lineHeight: 1.6 } }}
          />

          <Group gap="sm">
            <Button color="green" onClick={handleSaveText} disabled={saving || !textContent.trim()} loading={saving}>
              Save Text
            </Button>

            <Button
              onClick={handleTokenize}
              disabled={saving || !textContent.trim() || isTextDirty || hasTokens}
              title={isTextDirty ? 'Please save text changes before tokenizing' : (hasTokens ? 'Clear tokens before re-tokenizing' : '')}
            >
              Basic Tokenize
            </Button>

            {hasTokens && (
              <Button color="red" onClick={handleClearTokens} disabled={saving}>
                Clear Tokens
              </Button>
            )}

            <Text size="sm" fw={500} c="dimmed" ml="auto">
              {wordTokens.length} word{wordTokens.length !== 1 ? 's' : ''}, {sentenceTokens.length} sentence{sentenceTokens.length !== 1 ? 's' : ''}
            </Text>
          </Group>

          <Text size="sm">
            {saving && <Text span c="blue" fs="italic">Processing...</Text>}
            {!saving && lastSaved && (
              <Text span c="green">Saved: {lastSaved.toLocaleTimeString()}</Text>
            )}
            {!saving && !lastSaved && textContent && isTextDirty && (
              <Text span c="yellow.8" fs="italic">Unsaved changes</Text>
            )}
          </Text>
        </Stack>

        <Paper withBorder bg="gray.0" p="md" radius="md">
          <Title order={4} mb="md">Token Visualization</Title>
          <TokenVisualizer
            text={textContent}
            originalText={originalTokenizedText}
            sentenceTokens={sentenceTokens}
            wordTokens={wordTokens}
            morphemeTokens={morphemeTokens}
            morphemeForms={morphemeForms}
            onWordCreate={handleWordCreate}
            onWordUpdate={handleWordUpdate}
            onWordDelete={handleWordDelete}
            onSentenceToggle={handleSentenceBoundaryToggle}
            onSetWordMorphemes={handleSetWordMorphemes}
            setError={(msg) => doc.setError(msg)}
          />
        </Paper>
      </SimpleGrid>
    </>
  );
};
