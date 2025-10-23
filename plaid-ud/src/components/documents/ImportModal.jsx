import { useState, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { parseCoNLLU, reconstructText, calculateTokenPositions } from '../../utils/conlluParser';
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
      const textLayer = fullDocument.textLayers?.[0];
      const tokenLayer = textLayer?.tokenLayers?.[0];
      
      if (!textLayer || !tokenLayer) {
        throw new Error('Failed to find text or token layers in created document');
      }

      // Get all span layers
      const spanLayers = tokenLayer.spanLayers || [];
      const lemmaLayer = spanLayers.find(layer => layer.name === 'Lemma');
      const uposLayer = spanLayers.find(layer => layer.name === 'UPOS');
      const xposLayer = spanLayers.find(layer => layer.name === 'XPOS');
      const featuresLayer = spanLayers.find(layer => layer.name === 'Features');
      const sentenceLayer = spanLayers.find(layer => layer.name === 'Sentence');
      const mwtLayer = spanLayers.find(layer => layer.name === 'Multi-word Tokens');

      // Step 4: Reconstruct text and create it
      const reconstructedText = reconstructText(parsedData);
      const textResponse = await client.texts.create(
        textLayer.id,
        createdDocumentId,
        reconstructedText
      );
      const textId = textResponse.id;

      // Step 5: Calculate token positions
      const tokenPositions = calculateTokenPositions(parsedData, reconstructedText);

      // Step 6: Create tokens in bulk
      const tokenOperations = [];
      let tokenIndex = 0;
      
      for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
        const sentence = parsedData.sentences[sentIdx];
        const sentencePositions = tokenPositions[sentIdx];
        
        for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
          const position = sentencePositions[tokIdx];
          tokenOperations.push({
            tokenLayerId: tokenLayer.id,
            text: textId,
            begin: position.begin,
            end: position.end
          });
          tokenIndex++;
        }
      }

      const tokenResult = await client.tokens.bulkCreate(tokenOperations);
      const createdTokenIds = tokenResult.ids || [];

      // Map token IDs to sentence and token indices
      const tokenIdMap = [];
      let globalTokenIndex = 0;
      
      for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
        const sentence = parsedData.sentences[sentIdx];
        const sentenceTokenIds = [];
        
        for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
          sentenceTokenIds.push(createdTokenIds[globalTokenIndex]);
          globalTokenIndex++;
        }
        
        tokenIdMap.push(sentenceTokenIds);
      }

      // Step 7: Create spans by layer using bulkCreate for each layer
      const allCreatedSpans = [];
      const lemmaSpanIds = [];
      
      // Initialize lemma span tracking
      for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
        lemmaSpanIds.push([]);
        for (let tokIdx = 0; tokIdx < parsedData.sentences[sentIdx].tokens.length; tokIdx++) {
          lemmaSpanIds[sentIdx].push(null);
        }
      }

      // Create sentence boundaries
      if (sentenceLayer) {
        const sentenceSpans = [];
        for (let sentIdx = 0; sentIdx < tokenIdMap.length; sentIdx++) {
          const firstTokenId = tokenIdMap[sentIdx][0];
          const metadata = parsedData.sentences[sentIdx].metadata;
          
          sentenceSpans.push({
            spanLayerId: sentenceLayer.id,
            tokens: [firstTokenId],
            value: null,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined
          });
        }
        
        if (sentenceSpans.length > 0) {
          const result = await client.spans.bulkCreate(sentenceSpans);
          console.log(`Created ${sentenceSpans.length} sentence spans`);
        }
      }

      // Create multi-word token spans
      if (mwtLayer) {
        const mwtSpans = [];
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (const mwt of sentence.multiWordTokens || []) {
            // Convert 1-based token IDs to 0-based indices for our token array
            const startIdx = mwt.start - 1;
            const endIdx = mwt.end - 1;
            
            // Validate range is within the sentence
            if (startIdx >= 0 && endIdx < sentenceTokenIds.length && startIdx <= endIdx) {
              // Get the token IDs for this MWT range
              const mwtTokenIds = [];
              for (let i = startIdx; i <= endIdx; i++) {
                mwtTokenIds.push(sentenceTokenIds[i]);
              }
              
              mwtSpans.push({
                spanLayerId: mwtLayer.id,
                tokens: mwtTokenIds,
                value: null, // MWT span values are always null - form is computed from tokens
                metadata: mwt.misc ? { misc: mwt.misc } : undefined
              });
            }
          }
        }
        
        if (mwtSpans.length > 0) {
          const result = await client.spans.bulkCreate(mwtSpans);
          console.log(`Created ${mwtSpans.length} multi-word token spans`);
        }
      }

      // Create lemma spans
      if (lemmaLayer) {
        const lemmaSpans = [];
        const lemmaOperations = [];
        
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            if (token.lemma) {
              lemmaSpans.push({
                spanLayerId: lemmaLayer.id,
                tokens: [sentenceTokenIds[tokIdx]],
                value: token.lemma
              });
              lemmaOperations.push({ sentenceIndex: sentIdx, tokenIndex: tokIdx });
            }
          }
        }
        
        if (lemmaSpans.length > 0) {
          const result = await client.spans.bulkCreate(lemmaSpans);
          const createdLemmaIds = result.ids || [];
          console.log(`Created ${lemmaSpans.length} lemma spans`);
          
          // Map lemma span IDs for dependency relations
          for (let i = 0; i < lemmaOperations.length; i++) {
            const operation = lemmaOperations[i];
            lemmaSpanIds[operation.sentenceIndex][operation.tokenIndex] = createdLemmaIds[i];
          }
        }
      }

      // Create UPOS spans
      if (uposLayer) {
        const uposSpans = [];
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            if (token.upos) {
              uposSpans.push({
                spanLayerId: uposLayer.id,
                tokens: [sentenceTokenIds[tokIdx]],
                value: token.upos
              });
            }
          }
        }
        
        if (uposSpans.length > 0) {
          const result = await client.spans.bulkCreate(uposSpans);
          console.log(`Created ${uposSpans.length} UPOS spans`);
        }
      }

      // Create XPOS spans
      if (xposLayer) {
        const xposSpans = [];
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            if (token.xpos) {
              xposSpans.push({
                spanLayerId: xposLayer.id,
                tokens: [sentenceTokenIds[tokIdx]],
                value: token.xpos
              });
            }
          }
        }
        
        if (xposSpans.length > 0) {
          const result = await client.spans.bulkCreate(xposSpans);
          console.log(`Created ${xposSpans.length} XPOS spans`);
        }
      }

      // Create Features spans (one per feature)
      if (featuresLayer) {
        const featureSpans = [];
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            for (const feat of token.feats) {
              featureSpans.push({
                spanLayerId: featuresLayer.id,
                tokens: [sentenceTokenIds[tokIdx]],
                value: feat
              });
            }
          }
        }
        
        if (featureSpans.length > 0) {
          const result = await client.spans.bulkCreate(featureSpans);
          console.log(`Created ${featureSpans.length} feature spans`);
        }
      }

      // Step 8: Create dependency relations using bulkCreate
      if (lemmaLayer && lemmaSpanIds.length > 0) {
        const relationLayer = lemmaLayer.relationLayers?.[0];
        
        if (relationLayer) {
          console.log('Creating dependency relations with layer:', relationLayer.id);
          console.log('Lemma span IDs:', lemmaSpanIds);
          
          const relationOperations = [];
          
          for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
            const sentence = parsedData.sentences[sentIdx];
            const sentenceLemmaIds = lemmaSpanIds[sentIdx];
            
            for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
              const token = sentence.tokens[tokIdx];
              const targetLemmaId = sentenceLemmaIds[tokIdx];
              
              if (token.deprel && targetLemmaId) {
                if (token.head === 0) {
                  // Root edge: create self-referencing relation
                  console.log(`Creating root relation: ${targetLemmaId} -> ${targetLemmaId} (${token.deprel})`);
                  relationOperations.push({
                    relationLayerId: relationLayer.id,
                    source: targetLemmaId,
                    target: targetLemmaId,
                    value: token.deprel
                  });
                } else if (token.head > 0) {
                  // Regular edge: head is 1-based, convert to 0-based index
                  const headIdx = token.head - 1;
                  if (headIdx < sentenceLemmaIds.length) {
                    const sourceLemmaId = sentenceLemmaIds[headIdx];
                    if (sourceLemmaId) {
                      console.log(`Creating relation: ${sourceLemmaId} -> ${targetLemmaId} (${token.deprel})`);
                      relationOperations.push({
                        relationLayerId: relationLayer.id,
                        source: sourceLemmaId,
                        target: targetLemmaId,
                        value: token.deprel
                      });
                    }
                  }
                }
              }
            }
          }
          
          if (relationOperations.length > 0) {
            const relationResult = await client.relations.bulkCreate(relationOperations);
            console.log(`Created ${relationOperations.length} dependency relations`);
            console.log('Relation bulk create result:', relationResult);
          } else {
            console.log('No dependency relations to create');
          }
        } else {
          console.warn('No relation layer found for lemma layer');
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