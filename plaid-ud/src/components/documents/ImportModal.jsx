import { useState, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { parseCoNLLU, buildConlluHierarchy } from '../../utils/conlluParser';
import { getUdLayerInfo, missingUdLayerLabels } from '../../utils/udLayerUtils.js';
import { Modal, Button, FormField, ErrorMessage } from '../ui';

export const ImportModal = ({ projectId, isOpen, onClose, onSuccess }) => {
  const [importText, setImportText] = useState('');
  const [documentName, setDocumentName] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [importMethod, setImportMethod] = useState('paste'); // 'paste' or 'upload'
  const fileInputRef = useRef(null);
  const { getClient } = useAuth();

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setImportText(event.target.result);
      // Extract document name from filename (remove .conllu extension)
      const fileName = file.name.replace(/\.conllu$/i, '');
      if (!documentName) {
        setDocumentName(fileName);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const performImport = async () => {
    if (!documentName.trim()) {
      setError('Document name is required');
      return;
    }

    if (!importText.trim()) {
      setError('No content to import');
      return;
    }

    setLoading(true);
    setError('');

    const client = getClient();
    let createdDocumentId = null;

    try {
      // Step 1: Parse CoNLL-U
      const parsedData = parseCoNLLU(importText);

      if (parsedData.sentences.length === 0) {
        throw new Error('No valid sentences found in CoNLL-U data');
      }

      // Step 2: Create document
      const documentResponse = await client.documents.create(projectId, documentName);
      createdDocumentId = documentResponse.id;

      // Step 3: Get document with layers to find IDs
      const fullDocument = await client.documents.get(createdDocumentId, true);
      const layerInfo = getUdLayerInfo(fullDocument);

      if (!layerInfo.isConfigured) {
        const missingLabels = missingUdLayerLabels(layerInfo.missingLayers).join(', ');
        throw new Error(
          missingLabels
            ? `Project is missing required UD layer configuration: ${missingLabels}. Configure the project before importing.`
            : 'Project is missing required UD layer configuration. Configure the project before importing.'
        );
      }

      const {
        textLayer,
        sentenceTokenLayer,
        wordTokenLayer,
        morphemeTokenLayer,
        formLayer,
        lemmaLayer,
        uposLayer,
        xposLayer,
        featuresLayer,
        relationLayer
      } = layerInfo;

      // Step 4: Build the sentence > word > morpheme hierarchy with offsets
      const hierarchy = buildConlluHierarchy(parsedData);

      // Step 5: Create the text
      const textResponse = await client.texts.create(
        textLayer.id,
        createdDocumentId,
        hierarchy.text
      );
      const textId = textResponse.id;

      // Build token operations for the three layers (sentences -> words ->
      // morphemes), tracking each morpheme's originating row + sentence so we can
      // attach spans and wire up dependency relations afterwards. We carry CoNLL-U
      // metadata onto the tokens so the export side can round-trip it:
      // arbitrary `# k = v` lines on the sentence token, and the MWT MISC column
      // on the word token.
      const sentenceOps = hierarchy.sentences.map(s => {
        const op = { tokenLayerId: sentenceTokenLayer.id, text: textId, begin: s.begin, end: s.end };
        if (s.metadata && Object.keys(s.metadata).length > 0) op.metadata = s.metadata;
        return op;
      });
      const wordOps = [];
      hierarchy.sentences.forEach(s => s.words.forEach(w => {
        const op = { tokenLayerId: wordTokenLayer.id, text: textId, begin: w.begin, end: w.end };
        // For MWTs only, persist the surface form on the word's metadata so the
        // exporter can round-trip it. (For 1:1 words, the body substring is the
        // surface form — the exporter falls back to that and we keep word
        // metadata clean.)
        const meta = {};
        if (w.isMwt && w.surfaceForm) meta.form = w.surfaceForm;
        if (w.misc) meta.misc = w.misc;
        if (Object.keys(meta).length > 0) op.metadata = meta;
        wordOps.push(op);
      }));
      const morphemeOps = [];
      const morphemeMeta = []; // { sentIdx, row, wordSubstring }
      hierarchy.sentences.forEach((s, sentIdx) => {
        s.words.forEach(w => {
          const wordSubstring = hierarchy.text.substring(w.begin, w.end);
          w.morphemes.forEach(m => {
            morphemeOps.push({
              tokenLayerId: morphemeTokenLayer.id,
              text: textId,
              begin: m.begin,
              end: m.end,
              precedence: m.precedence
            });
            morphemeMeta.push({ sentIdx, row: m.row, wordSubstring });
          });
        });
      });

      // Step 6: Create the token hierarchy atomically in one batch (sentences ->
      // words -> morphemes). Batch ops run sequentially so each nested layer sees
      // the one above it, the whole hierarchy rolls back together on failure, and
      // the batch returns each op's ids (used below for the morpheme spans).
      client.beginBatch();
      client.tokens.bulkCreate(sentenceOps);
      let morphemeResultIndex = -1;
      if (wordOps.length > 0) client.tokens.bulkCreate(wordOps);
      if (morphemeOps.length > 0) {
        client.tokens.bulkCreate(morphemeOps);
        morphemeResultIndex = (wordOps.length > 0) ? 2 : 1;
      }
      const tokenResults = await client.submitBatch();
      const morphemeIds = morphemeResultIndex >= 0
        ? (tokenResults[morphemeResultIndex]?.body?.ids || [])
        : [];

      // Step 7: Create annotation spans on morphemes.
      // Per-sentence lemma span ids indexed by row (0-based) for relation wiring.
      const lemmaSpanIds = parsedData.sentences.map(s => s.tokens.map(() => null));

      const formOps = [];
      const lemmaOps = [];
      const lemmaMeta = []; // parallel to lemmaOps: { sentIdx, rowIndex }
      const uposOps = [];
      const xposOps = [];
      const featOps = [];

      morphemeMeta.forEach((meta, i) => {
        const morphemeId = morphemeIds[i];
        if (!morphemeId) return;
        const row = meta.row;
        const rowIndex = row.id - 1;

        // A Form span is only needed when the surface form differs from the
        // morpheme's substring (i.e. real MWT components); 1:1 words fall back
        // to the substring.
        if (formLayer && row.form && row.form !== meta.wordSubstring) {
          formOps.push({ spanLayerId: formLayer.id, tokens: [morphemeId], value: row.form });
        }
        if (lemmaLayer && row.lemma) {
          lemmaOps.push({ spanLayerId: lemmaLayer.id, tokens: [morphemeId], value: row.lemma });
          lemmaMeta.push({ sentIdx: meta.sentIdx, rowIndex });
        }
        if (uposLayer && row.upos) {
          uposOps.push({ spanLayerId: uposLayer.id, tokens: [morphemeId], value: row.upos });
        }
        if (xposLayer && row.xpos) {
          xposOps.push({ spanLayerId: xposLayer.id, tokens: [morphemeId], value: row.xpos });
        }
        if (featuresLayer && Array.isArray(row.feats)) {
          row.feats.forEach(f => featOps.push({ spanLayerId: featuresLayer.id, tokens: [morphemeId], value: f }));
        }
      });

      // Bundle all five span bulkCreates into ONE atomic batch so a partial
      // failure rolls them back together. Track the result index for lemma so we
      // can recover ids for the follow-up relation batch.
      client.beginBatch();
      const spanOpsInOrder = []; // [{ kind, ops }] in batch order, to find lemma result
      if (formOps.length) { client.spans.bulkCreate(formOps); spanOpsInOrder.push('form'); }
      if (lemmaOps.length) { client.spans.bulkCreate(lemmaOps); spanOpsInOrder.push('lemma'); }
      if (uposOps.length) { client.spans.bulkCreate(uposOps); spanOpsInOrder.push('upos'); }
      if (xposOps.length) { client.spans.bulkCreate(xposOps); spanOpsInOrder.push('xpos'); }
      if (featOps.length) { client.spans.bulkCreate(featOps); spanOpsInOrder.push('feat'); }
      let spanResults = [];
      if (spanOpsInOrder.length > 0) {
        spanResults = await client.submitBatch();
      }
      const lemmaResultIdx = spanOpsInOrder.indexOf('lemma');
      if (lemmaResultIdx >= 0) {
        const ids = spanResults[lemmaResultIdx]?.body?.ids || [];
        lemmaMeta.forEach((lm, k) => { lemmaSpanIds[lm.sentIdx][lm.rowIndex] = ids[k]; });
      }

      // Step 8: Create dependency relations on lemma spans (head/deprel).
      // Relations reference span ids produced by the previous batch, so they
      // must go in a separate follow-up batch (the "no within-batch references"
      // constraint).
      if (relationLayer) {
        const relationOps = [];
        parsedData.sentences.forEach((sentence, sentIdx) => {
          const ids = lemmaSpanIds[sentIdx];
          sentence.tokens.forEach((token, tokIdx) => {
            const targetId = ids[tokIdx];
            if (!token.deprel || !targetId) return;
            if (token.head === 0) {
              // Root edge: self-referencing relation
              relationOps.push({ relationLayerId: relationLayer.id, source: targetId, target: targetId, value: token.deprel });
            } else if (token.head > 0) {
              const sourceId = ids[token.head - 1];
              if (sourceId) {
                relationOps.push({ relationLayerId: relationLayer.id, source: sourceId, target: targetId, value: token.deprel });
              }
            }
          });
        });
        if (relationOps.length > 0) {
          client.beginBatch();
          client.relations.bulkCreate(relationOps);
          await client.submitBatch();
        }
      }

      // Success!
      setSuccess(true);
      setTimeout(() => {
        onSuccess();
      }, 2000); // Show success state for 2 seconds

    } catch (err) {
      console.error('Import failed:', err);
      setError(`Import failed: ${err.message || 'Unknown error'}`);

      // Clean up: delete document if it was created
      if (createdDocumentId) {
        try {
          await client.documents.delete(createdDocumentId);
        } catch (deleteErr) {
          console.error('Failed to clean up document:', deleteErr);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={success ? 'Import Successful!' : 'Import CoNLL-U Document'}
      size="large"
    >
      <div className="p-6 space-y-4">
        {success && (
          <div className="rounded-md bg-green-50 p-4">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-green-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-sm text-green-800">Document imported successfully! Redirecting...</p>
            </div>
          </div>
        )}

        <ErrorMessage message={error} />

        <FormField
          label="Document Name"
          name="documentName"
          value={documentName}
          onChange={(e) => setDocumentName(e.target.value)}
          placeholder="Enter document name"
          required
          disabled={loading}
        />

        <div className="space-y-4">
          <div className="flex gap-4">
            <Button
              type="button"
              onClick={() => setImportMethod('paste')}
              variant={importMethod === 'paste' ? 'primary' : 'secondary'}
              disabled={loading}
            >
              Paste Text
            </Button>
            <Button
              type="button"
              onClick={() => setImportMethod('upload')}
              variant={importMethod === 'upload' ? 'primary' : 'secondary'}
              disabled={loading}
            >
              Upload File
            </Button>
          </div>

          {importMethod === 'paste' ? (
            <FormField
              label="CoNLL-U Text"
              name="conlluText"
              disabled={loading}
            >
              <textarea
                id="conlluText"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="Paste your CoNLL-U formatted text here..."
                rows={15}
                disabled={loading}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </FormField>
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".conllu,.txt"
                onChange={handleFileUpload}
                className="hidden"
                disabled={loading}
              />
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                variant="secondary"
              >
                Choose File...
              </Button>
              {importText && (
                <div className="mt-4 p-4 bg-gray-50 rounded-md">
                  <p className="text-sm text-gray-600 mb-2">File loaded. Preview:</p>
                  <pre className="text-xs font-mono text-gray-700 overflow-x-auto max-h-40 overflow-y-auto">
                    {importText.substring(0, 500)}
                    {importText.length > 500 && '...'}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="p-6 border-t border-gray-200 bg-gray-50">
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={performImport}
            disabled={loading || !importText.trim() || !documentName.trim()}
            isLoading={loading}
          >
            {loading ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
