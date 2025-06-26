import { useState, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { parseCoNLLU, reconstructText, calculateTokenPositions } from '../../utils/conlluParser';

export const ImportModal = ({ projectId, onClose, onSuccess }) => {
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
            textId: textId,
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

      // Step 7: Create all spans in batch operations
      client.beginBatch();
      
      // Track the order of span creation for mapping results
      const spanOperations = [];

      // Create sentence boundaries
      if (sentenceLayer) {
        for (let sentIdx = 0; sentIdx < tokenIdMap.length; sentIdx++) {
          const firstTokenId = tokenIdMap[sentIdx][0];
          const metadata = parsedData.sentences[sentIdx].metadata;
          
          client.spans.create(
            sentenceLayer.id,
            [firstTokenId],
            null,
            Object.keys(metadata).length > 0 ? metadata : undefined
          );
          spanOperations.push({ type: 'sentence', sentenceIndex: sentIdx });
        }
      }

      // Create multi-word token spans
      if (mwtLayer) {
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
              
              client.spans.create(
                mwtLayer.id,
                mwtTokenIds,
                null, // MWT span values are always null - form is computed from tokens
                mwt.misc ? { misc: mwt.misc } : undefined
              );
              spanOperations.push({ 
                type: 'mwt', 
                sentenceIndex: sentIdx, 
                start: mwt.start,
                end: mwt.end
              });
            }
          }
        }
      }

      // Create lemma spans
      if (lemmaLayer) {
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            if (token.lemma) {
              client.spans.create(
                lemmaLayer.id,
                [sentenceTokenIds[tokIdx]],
                token.lemma
              );
              spanOperations.push({ 
                type: 'lemma', 
                sentenceIndex: sentIdx, 
                tokenIndex: tokIdx,
                token: token
              });
            }
          }
        }
      }

      // Create UPOS spans
      if (uposLayer) {
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            if (token.upos) {
              client.spans.create(
                uposLayer.id,
                [sentenceTokenIds[tokIdx]],
                token.upos
              );
              spanOperations.push({ type: 'upos', sentenceIndex: sentIdx, tokenIndex: tokIdx });
            }
          }
        }
      }

      // Create XPOS spans
      if (xposLayer) {
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            if (token.xpos) {
              client.spans.create(
                xposLayer.id,
                [sentenceTokenIds[tokIdx]],
                token.xpos
              );
              spanOperations.push({ type: 'xpos', sentenceIndex: sentIdx, tokenIndex: tokIdx });
            }
          }
        }
      }

      // Create Features spans (one per feature)
      if (featuresLayer) {
        for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
          const sentence = parsedData.sentences[sentIdx];
          const sentenceTokenIds = tokenIdMap[sentIdx];
          
          for (let tokIdx = 0; tokIdx < sentence.tokens.length; tokIdx++) {
            const token = sentence.tokens[tokIdx];
            for (const feat of token.feats) {
              client.spans.create(
                featuresLayer.id,
                [sentenceTokenIds[tokIdx]],
                feat
              );
              spanOperations.push({ type: 'feature', sentenceIndex: sentIdx, tokenIndex: tokIdx });
            }
          }
        }
      }

      // Submit all span creations
      const batchResults = await client.submitBatch();
      console.log('Span batch results:', batchResults);
      
      // Check for batch failures
      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        if (!result || !result.body || !result.body.id) {
          throw new Error(`Span creation failed for operation ${i}: ${JSON.stringify(result)}`);
        }
      }
      
      // Extract lemma span IDs for dependency relations
      const lemmaSpanIds = [];
      for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
        lemmaSpanIds.push([]);
        for (let tokIdx = 0; tokIdx < parsedData.sentences[sentIdx].tokens.length; tokIdx++) {
          lemmaSpanIds[sentIdx].push(null);
        }
      }
      
      // Map batch results to lemma spans
      for (let i = 0; i < spanOperations.length; i++) {
        const operation = spanOperations[i];
        const result = batchResults[i];
        
        if (operation.type === 'lemma') {
          lemmaSpanIds[operation.sentenceIndex][operation.tokenIndex] = result.body.id;
        }
      }

      // Step 8: Create dependency relations in a second batch
      if (lemmaLayer && lemmaSpanIds.length > 0) {
        const relationLayer = lemmaLayer.relationLayers?.[0];
        
        if (relationLayer) {
          console.log('Creating dependency relations with layer:', relationLayer.id);
          console.log('Lemma span IDs:', lemmaSpanIds);
          
          client.beginBatch();
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
                  client.relations.create(
                    relationLayer.id,
                    targetLemmaId,
                    targetLemmaId,
                    token.deprel
                  );
                  relationOperations.push({
                    source: targetLemmaId,
                    target: targetLemmaId,
                    label: token.deprel
                  });
                } else if (token.head > 0) {
                  // Regular edge: head is 1-based, convert to 0-based index
                  const headIdx = token.head - 1;
                  if (headIdx < sentenceLemmaIds.length) {
                    const sourceLemmaId = sentenceLemmaIds[headIdx];
                    if (sourceLemmaId) {
                      console.log(`Creating relation: ${sourceLemmaId} -> ${targetLemmaId} (${token.deprel})`);
                      client.relations.create(
                        relationLayer.id,
                        sourceLemmaId,
                        targetLemmaId,
                        token.deprel
                      );
                      relationOperations.push({
                        source: sourceLemmaId,
                        target: targetLemmaId,
                        label: token.deprel
                      });
                    }
                  }
                }
              }
            }
          }
          
          if (relationOperations.length > 0) {
            const relationResults = await client.submitBatch();
            console.log(`Created ${relationOperations.length} dependency relations`);
            console.log('Relation batch results:', relationResults);
            
            // Check for relation batch failures
            for (let i = 0; i < relationResults.length; i++) {
              const result = relationResults[i];
              if (!result || !result.body || !result.body.id) {
                throw new Error(`Relation creation failed for operation ${i}: ${JSON.stringify(result)}`);
              }
            }
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
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">
            {success ? 'Import Successful!' : 'Import CoNLL-U Document'}
          </h3>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6">
          {success && (
            <div className="rounded-md bg-green-50 p-4 mb-4">
              <div className="flex items-center">
                <svg className="w-5 h-5 text-green-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-sm text-green-800">Document imported successfully! Redirecting...</p>
              </div>
            </div>
          )}
          
          {error && (
            <div className="rounded-md bg-red-50 p-4 mb-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
          
          <div className="mb-4">
            <label htmlFor="documentName" className="block text-sm font-medium text-gray-700 mb-1">
              Document Name
            </label>
            <input
              id="documentName"
              type="text"
              value={documentName}
              onChange={(e) => setDocumentName(e.target.value)}
              placeholder="Enter document name"
              required
              disabled={loading}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          <div className="mb-4">
            <div className="flex gap-4 mb-4">
              <button
                type="button"
                onClick={() => setImportMethod('paste')}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  importMethod === 'paste'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                disabled={loading}
              >
                Paste Text
              </button>
              <button
                type="button"
                onClick={() => setImportMethod('upload')}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  importMethod === 'upload'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                disabled={loading}
              >
                Upload File
              </button>
            </div>

            {importMethod === 'paste' ? (
              <div>
                <label htmlFor="conlluText" className="block text-sm font-medium text-gray-700 mb-1">
                  CoNLL-U Text
                </label>
                <textarea
                  id="conlluText"
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="Paste your CoNLL-U formatted text here..."
                  rows={15}
                  disabled={loading}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
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
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
                >
                  Choose File...
                </button>
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
            <button 
              type="button" 
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              Cancel
            </button>
            <button 
              type="button"
              onClick={performImport}
              disabled={loading || !importText.trim() || !documentName.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Importing...
                </>
              ) : (
                'Import'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};