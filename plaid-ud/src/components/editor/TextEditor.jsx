import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { missingUdLayerLabels } from '../../utils/udLayerUtils.js';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
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

  const handleClearTokens = async () => {
    if (!doc) return;
    if (!confirm('Are you sure you want to clear all tokens? This action cannot be undone.')) return;
    const ok = await doc.clearTokens();
    if (ok) setOriginalTokenizedText('');
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
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
  }

  if (loadError) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">{loadError}</p>
      </div>
    );
  }

  if (!doc || !project) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">Document or project not found</p>
      </div>
    );
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
    <div>
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={doc.raw}
      />

      {opError && (
        <div className="mb-3 mx-6 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800">
          {opError}
        </div>
      )}

      {missingLayerLabels.length > 0 && (
        <div className="mb-3 mx-6 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          Project configuration incomplete: {missingLayerLabels.join(', ')}.
        </div>
      )}

      {layersMisconfigured && (
        <div className="mb-3 mx-6 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          This project's token layers are missing their overlap-mode / parent
          configuration (likely created with an older client bundle). Tokenization
          will still work, but server-enforced nesting and partitioning won't.
          Consider recreating the project.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Text Content</h3>
          <textarea
            className="w-full min-h-[300px] p-4 border-2 border-gray-300 rounded-md font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            value={textContent}
            onChange={handleTextChange}
            placeholder="Enter your text here. Use newlines to separate sentences.

Example:
The quick brown fox jumps over the lazy dog.
This is a second sentence for testing."
            rows={12}
          />

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={handleSaveText}
              disabled={saving || !textContent.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving...' : 'Save Text'}
            </button>

            <button
              onClick={handleTokenize}
              disabled={saving || !textContent.trim() || isTextDirty || hasTokens}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              title={isTextDirty ? 'Please save text changes before tokenizing' : (hasTokens ? 'Clear tokens before re-tokenizing' : '')}
            >
              {saving ? 'Processing...' : 'Basic Tokenize'}
            </button>

            {hasTokens && (
              <button
                onClick={handleClearTokens}
                disabled={saving}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                Clear Tokens
              </button>
            )}

            <div className="ml-auto text-sm font-medium text-gray-600">
              {wordTokens.length} word{wordTokens.length !== 1 ? 's' : ''}, {sentenceTokens.length} sentence{sentenceTokens.length !== 1 ? 's' : ''}
            </div>
          </div>

          <div className="mt-2 text-sm">
            {saving && <span className="text-blue-600 italic">Processing...</span>}
            {!saving && lastSaved && (
              <span className="text-green-600">
                Saved: {lastSaved.toLocaleTimeString()}
              </span>
            )}
            {!saving && !lastSaved && textContent && isTextDirty && (
              <span className="text-yellow-600 italic">Unsaved changes</span>
            )}
          </div>
        </div>

        <div className="border border-gray-200 rounded-md p-4 bg-gray-50">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Token Visualization</h3>
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
        </div>
      </div>
    </div>
  );
};
