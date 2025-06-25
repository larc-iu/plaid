import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { TokenVisualizer } from './TokenVisualizer';

export const TextEditor = () => {
  const { projectId, documentId } = useParams();
  const [document, setDocument] = useState(null);
  const [project, setProject] = useState(null);
  const [textContent, setTextContent] = useState('');
  const [originalTokenizedText, setOriginalTokenizedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [lastSaved, setLastSaved] = useState(null);
  const { getClient } = useAuth();

  // Fetch initial data
  const fetchData = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        window.location.href = '/login';
        return;
      }

      // Get project and document with all layer data
      const [projectData, documentData] = await Promise.all([
        client.projects.get(projectId),
        client.documents.get(documentId, true) // This includes all layer data!
      ]);

      setProject(projectData);
      setDocument(documentData);

      // Extract text content from the document structure
      const textLayer = documentData.textLayers?.[0];
      const text = textLayer?.text;
      if (text?.body) {
        setTextContent(text.body);
        
        // If we have tokens and no original tokenized text stored, use current text
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const tokens = tokenLayer?.tokens || [];
        if (tokens.length > 0 && !originalTokenizedText) {
          setOriginalTokenizedText(text.body);
        }
      }

      setError('');
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId, documentId]);

  // Get helper data from document structure
  const getLayerData = () => {
    if (!document) return {};
    const textLayer = document.textLayers?.[0];
    const text = textLayer?.text;
    const tokenLayer = textLayer?.tokenLayers?.[0];
    const tokens = tokenLayer?.tokens || [];
    
    // Find the span layers
    const spanLayers = tokenLayer?.spanLayers || [];
    const sentenceLayer = spanLayers.find(layer => layer.name === 'Sentence');
    const sentenceSpans = sentenceLayer?.spans || [];
    
    // Find the Lemma span layer and its relation layer
    const lemmaLayer = spanLayers.find(layer => layer.name === 'Lemma');
    const lemmaSpans = lemmaLayer?.spans || [];
    const relationLayer = lemmaLayer?.relationLayers?.[0];
    const relations = relationLayer?.relations || [];
    
    return { 
      textLayer, 
      text, 
      tokenLayer, 
      tokens, 
      sentenceLayer, 
      sentenceSpans,
      lemmaLayer,
      lemmaSpans,
      relationLayer,
      relations
    };
  };

  // Save text function
  const saveText = async () => {
    if (!textContent.trim() || saving) return;

    try {
      setSaving(true);
      const client = getClient();
      const { textLayer, text } = getLayerData();
      
      if (text?.id) {
        // Update existing text
        await client.texts.update(text.id, textContent);
      } else if (textLayer?.id) {
        // Create new text
        await client.texts.create(
          textLayer.id,
          documentId,
          textContent
        );
      }
      
      setLastSaved(new Date());
      setError('');
      // Force a full page reload to ensure everything is in sync
      window.location.reload();
    } catch (err) {
      setError('Failed to save text: ' + (err.message || 'Unknown error'));
      console.error('Error saving text:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTextChange = (e) => {
    setTextContent(e.target.value);
  };

  const handleTokenize = async () => {
    const { text, tokenLayer, tokens } = getLayerData();
    
    if (!textContent.trim()) {
      setError('Please enter some text before tokenizing');
      return;
    }

    if (!text?.id) {
      setError('Please save the text first before tokenizing');
      return;
    }

    try {
      setSaving(true);
      setError('');
      const client = getClient();
      
      // Helper function to check if two ranges overlap
      const rangesOverlap = (begin1, end1, begin2, end2) => {
        return begin1 < end2 && begin2 < end1;
      };
      
      // Generate proposed tokens from whitespace tokenization
      const proposedTokens = [];
      let currentIndex = 0;

      // Split by whitespace but preserve positions
      const parts = textContent.split(/(\s+)/);
      
      for (const part of parts) {
        if (part.trim()) {
          proposedTokens.push({
            tokenLayerId: tokenLayer.id,
            textId: text.id,
            begin: currentIndex,
            end: currentIndex + part.length,
          });
        }
        currentIndex += part.length;
      }

      // Filter out proposed tokens that overlap with existing tokens
      const nonOverlappingTokens = proposedTokens.filter(proposed => {
        return !tokens.some(existing => 
          rangesOverlap(proposed.begin, proposed.end, existing.begin, existing.end)
        );
      });

      const skippedCount = proposedTokens.length - nonOverlappingTokens.length;

      // Create only non-overlapping tokens
      if (nonOverlappingTokens.length > 0) {
        const tokenResult = await client.tokens.bulkCreate(nonOverlappingTokens);
        
        // Create corresponding lemma spans for the new tokens
        const { lemmaLayer } = getLayerData();
        if (lemmaLayer && tokenResult?.ids) {
          console.log(`Creating lemma spans for ${tokenResult.ids.length} new tokens`);
          
          const lemmaOperations = tokenResult.ids.map((tokenId, index) => {
            const tokenData = nonOverlappingTokens[index];
            return {
              spanLayerId: lemmaLayer.id,
              tokens: [tokenId],
              value: textContent.substring(tokenData.begin, tokenData.end) // Use token text as default lemma
            };
          });
          
          try {
            await client.spans.bulkCreate(lemmaOperations);
            console.log(`Successfully created ${lemmaOperations.length} lemma spans`);
          } catch (lemmaError) {
            console.error('Failed to create lemma spans:', lemmaError);
            // Don't fail the whole operation if lemma creation fails
          }
        }
      }

      // Store the text that was tokenized
      setOriginalTokenizedText(textContent);
      
      // Refresh document to get updated tokens
      await fetchData();
      
      // Show feedback about the operation
      if (skippedCount > 0) {
        setError(`Created ${nonOverlappingTokens.length} tokens. Skipped ${skippedCount} tokens that would overlap with existing tokens.`);
      } else if (nonOverlappingTokens.length === 0) {
        setError('No new tokens created - all proposed tokens would overlap with existing tokens.');
      }
      
    } catch (err) {
      setError('Failed to create tokens: ' + (err.message || 'Unknown error'));
      console.error('Error tokenizing:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleClearTokens = async () => {
    const { tokens } = getLayerData();
    
    if (!confirm('Are you sure you want to clear all tokens? This action cannot be undone.')) {
      return;
    }

    try {
      setSaving(true);
      const client = getClient();
      
      // Delete all tokens using bulk delete
      if (tokens.length > 0) {
        const tokenIds = tokens.map(token => token.id);
        await client.tokens.bulkDelete(tokenIds);
      }
      
      // Clear the original tokenized text
      setOriginalTokenizedText('');
      
      // Refresh document
      await fetchData();
      
    } catch (err) {
      setError('Failed to clear tokens: ' + (err.message || 'Unknown error'));
      console.error('Error clearing tokens:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTokenUpdate = async (tokenId, newBegin, newEnd) => {
    try {
      const client = getClient();
      console.log('Updating token:', tokenId, 'from', newBegin, 'to', newEnd);
      await client.tokens.update(tokenId, newBegin, newEnd);
      console.log('Token update successful');
      
      // Success - update the client-side state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument)); // Deep clone
        
        // Find and update the token in the document structure
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const tokens = tokenLayer?.tokens;
        
        if (tokens) {
          const tokenIndex = tokens.findIndex(token => token.id === tokenId);
          if (tokenIndex !== -1) {
            tokens[tokenIndex] = {
              ...tokens[tokenIndex],
              begin: newBegin,
              end: newEnd
            };
          }
        }
        
        return updatedDocument;
      });
    } catch (error) {
      // Error - refresh document
      console.error('Token update failed, refreshing:', error);
      await fetchData();
      throw error;
    }
  };

  const handleTokenDelete = async (tokenId) => {
    try {
      const client = getClient();
      console.log('Deleting token:', tokenId);
      await client.tokens.delete(tokenId);
      console.log('Token deletion successful');
      
      // Success - update the client-side state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument)); // Deep clone
        
        // Find and remove the token from the document structure
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const tokens = tokenLayer?.tokens;
        
        if (tokens) {
          const tokenIndex = tokens.findIndex(token => token.id === tokenId);
          if (tokenIndex !== -1) {
            tokens.splice(tokenIndex, 1);
          }
        }
        
        return updatedDocument;
      });
    } catch (error) {
      // Error - refresh document
      console.error('Token deletion failed, refreshing:', error);
      await fetchData();
      throw error;
    }
  };

  const handleTokenCreate = async (begin, end) => {
    try {
      const client = getClient();
      const { text, tokenLayer } = getLayerData();
      
      if (!text?.id || !tokenLayer?.id) {
        throw new Error('Missing text or token layer');
      }

      console.log('Creating token:', begin, 'to', end);
      const newToken = await client.tokens.create(tokenLayer.id, text.id, begin, end);
      console.log('Token creation successful, response:', newToken);
      
      // Create corresponding lemma span for the new token
      const { lemmaLayer } = getLayerData();
      if (lemmaLayer && newToken?.id) {
        try {
          const tokenText = textContent.substring(begin, end);
          await client.spans.create(lemmaLayer.id, [newToken.id], tokenText);
          console.log(`Created lemma span for token: "${tokenText}"`);
        } catch (lemmaError) {
          console.error('Failed to create lemma span:', lemmaError);
          // Don't fail the whole operation if lemma creation fails
        }
      }
      
      // Success - update the client-side state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument)); // Deep clone
        
        // Add the new token to the document structure
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayerDoc = textLayer?.tokenLayers?.[0];
        const tokens = tokenLayerDoc?.tokens;
        
        if (tokens) {
          // Ensure the token has the correct begin/end values
          const tokenToAdd = {
            ...newToken,
            begin: begin,
            end: end
          };
          console.log('Adding token to client state:', tokenToAdd);
          tokens.push(tokenToAdd);
        }
        
        return updatedDocument;
      });
    } catch (error) {
      // Error - refresh document
      console.error('Token creation failed, refreshing:', error);
      await fetchData();
      throw error;
    }
  };

  // Helper function to delete relations that cross sentence boundaries
  const deleteInvalidRelations = async (updatedSentenceSpans = null) => {
    const client = getClient();
    const { tokens, sentenceSpans, lemmaSpans, relations } = getLayerData();
    
    if (!relations || relations.length === 0) return [];
    
    // Use provided sentence spans or fall back to current ones
    const currentSentenceSpans = updatedSentenceSpans || sentenceSpans;
    
    // Build a map of token ID to sentence number
    const tokenToSentence = new Map();
    
    // Sort sentence spans by their starting token position
    const sentenceStartTokenIds = currentSentenceSpans
      .map(span => span.tokens?.[0] || span.begin)
      .filter(id => id != null);
    
    // Sort tokens by their position in text
    const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
    
    let currentSentence = 0;
    sortedTokens.forEach(token => {
      // Check if this token starts a new sentence
      if (sentenceStartTokenIds.includes(token.id) && tokenToSentence.size > 0) {
        currentSentence++;
      }
      tokenToSentence.set(token.id, currentSentence);
    });
    
    // Build a map of span ID to the tokens it covers
    const spanToTokens = new Map();
    lemmaSpans.forEach(span => {
      if (span.tokens && span.tokens.length > 0) {
        spanToTokens.set(span.id, span.tokens);
      }
    });
    
    // Find relations to delete
    const relationsToDelete = [];
    
    relations.forEach(relation => {
      const sourceTokens = spanToTokens.get(relation.source) || [];
      const targetTokens = spanToTokens.get(relation.target) || [];
      
      // Check if source and target are in different sentences
      let sourceSentence = null;
      let targetSentence = null;
      
      // Get sentence for source span (use first token)
      if (sourceTokens.length > 0) {
        sourceSentence = tokenToSentence.get(sourceTokens[0]);
      }
      
      // Get sentence for target span (use first token)
      if (targetTokens.length > 0) {
        targetSentence = tokenToSentence.get(targetTokens[0]);
      }
      
      // If they're in different sentences, mark for deletion
      if (sourceSentence !== null && targetSentence !== null && sourceSentence !== targetSentence) {
        relationsToDelete.push(relation);
      }
    });
    
    // Delete the invalid relations
    const deletedRelationIds = [];
    for (const relation of relationsToDelete) {
      try {
        await client.relations.delete(relation.id);
        deletedRelationIds.push(relation.id);
        console.log(`Deleted cross-sentence relation: ${relation.id} (${relation.value})`);
      } catch (error) {
        console.error(`Failed to delete relation ${relation.id}:`, error);
      }
    }
    
    return deletedRelationIds;
  };

  const handleSentenceToggle = async (tokenId, isStartOfSentence) => {
    try {
      const client = getClient();
      const { sentenceLayer, sentenceSpans, tokens } = getLayerData();
      
      if (!sentenceLayer?.id) {
        throw new Error('No sentence layer found');
      }

      const token = tokens.find(t => t.id === tokenId);
      if (!token) {
        throw new Error('Token not found');
      }

      // Find existing sentence span for this token
      const existingSpan = sentenceSpans.find(span => {
        // Check if span has tokens array
        if (span.tokens && span.tokens.length > 0) {
          return span.tokens.includes(token.id);
        }
        // Fallback to begin/end properties
        return span.begin === token.id && span.end === token.id;
      });

      if (isStartOfSentence && !existingSpan) {
        // Create new sentence span
        console.log('Creating sentence span for token:', tokenId);
        const newSpan = await client.spans.create(
          sentenceLayer.id,
          [token.id],
          null
        );
        
        // Delete any relations that now cross sentence boundaries
        // Create updated sentence spans array that includes the new span
        const updatedSentenceSpans = [...sentenceSpans, {
          ...newSpan,
          tokens: [token.id]
        }];
        const deletedRelationIds = await deleteInvalidRelations(updatedSentenceSpans);
        
        // Update client state
        setDocument(prevDocument => {
          const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
          const textLayer = updatedDocument.textLayers?.[0];
          const tokenLayer = textLayer?.tokenLayers?.[0];
          const spanLayers = tokenLayer?.spanLayers || [];
          const sentenceLayerDoc = spanLayers.find(layer => layer.name === 'Sentence');
          
          if (sentenceLayerDoc) {
            if (!sentenceLayerDoc.spans) {
              sentenceLayerDoc.spans = [];
            }
            // Ensure the span has the correct structure with tokens array
            const spanToAdd = {
              ...newSpan,
              tokens: [token.id]  // Ensure tokens array exists
            };
            sentenceLayerDoc.spans.push(spanToAdd);
          }
          
          // Remove deleted relations from the client state
          if (deletedRelationIds.length > 0) {
            const lemmaLayerDoc = spanLayers.find(layer => layer.name === 'Lemma');
            const relationLayerDoc = lemmaLayerDoc?.relationLayers?.[0];
            if (relationLayerDoc && relationLayerDoc.relations) {
              relationLayerDoc.relations = relationLayerDoc.relations.filter(
                relation => !deletedRelationIds.includes(relation.id)
              );
            }
          }
          
          return updatedDocument;
        });
      } else if (!isStartOfSentence && existingSpan) {
        // Delete existing sentence span
        console.log('Deleting sentence span:', existingSpan.id);
        await client.spans.delete(existingSpan.id);
        
        // Delete any relations that now cross sentence boundaries after removing this boundary
        // Create updated sentence spans array that excludes the deleted span
        const updatedSentenceSpans = sentenceSpans.filter(span => span.id !== existingSpan.id);
        const deletedRelationIds = await deleteInvalidRelations(updatedSentenceSpans);
        
        // Update client state
        setDocument(prevDocument => {
          const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
          const textLayer = updatedDocument.textLayers?.[0];
          const tokenLayer = textLayer?.tokenLayers?.[0];
          const spanLayers = tokenLayer?.spanLayers || [];
          const sentenceLayerDoc = spanLayers.find(layer => layer.name === 'Sentence');
          
          if (sentenceLayerDoc && sentenceLayerDoc.spans) {
            const spanIndex = sentenceLayerDoc.spans.findIndex(span => span.id === existingSpan.id);
            if (spanIndex !== -1) {
              sentenceLayerDoc.spans.splice(spanIndex, 1);
            }
          }
          
          // Remove deleted relations from the client state
          if (deletedRelationIds.length > 0) {
            const lemmaLayerDoc = spanLayers.find(layer => layer.name === 'Lemma');
            const relationLayerDoc = lemmaLayerDoc?.relationLayers?.[0];
            if (relationLayerDoc && relationLayerDoc.relations) {
              relationLayerDoc.relations = relationLayerDoc.relations.filter(
                relation => !deletedRelationIds.includes(relation.id)
              );
            }
          }
          
          return updatedDocument;
        });
      }
    } catch (error) {
      console.error('Sentence toggle failed, refreshing:', error);
      await fetchData();
      throw error;
    }
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
  }

  if (!document || !project) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">Document or project not found</p>
      </div>
    );
  }

  const { tokens, sentenceSpans } = getLayerData();
  
  // Check if text is dirty (different from what was tokenized or saved)
  const isTextDirty = originalTokenizedText && textContent !== originalTokenizedText;

  return (
    <div>
      <nav className="flex items-center text-sm text-gray-500 mb-6">
        <Link to="/projects" className="text-blue-600 hover:text-blue-800">Projects</Link>
        <span className="mx-2">/</span>
        <Link to={`/projects/${projectId}/documents`} className="text-blue-600 hover:text-blue-800">{project?.name}</Link>
        <span className="mx-2">/</span>
        <Link to={`/projects/${projectId}/documents/${document?.id}/annotate`} className="text-blue-600 hover:text-blue-800">{document?.name}</Link>
      </nav>

      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Text Editor: {document?.name}</h2>
        <div className="text-sm">
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

      {error && (
        <div className="rounded-md bg-red-50 p-4 mb-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Text Content</h3>
          <textarea
            className="w-full min-h-[300px] p-4 border-2 border-gray-300 rounded-md font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            value={textContent}
            onChange={handleTextChange}
            placeholder="Enter your text here. Use multiple newlines to separate sentences.

Example:
The quick brown fox jumps over the lazy dog.
This is a second sentence for testing."
            rows={12}
          />
          
          <div className="flex items-center gap-3 mt-4">
            <button 
              onClick={saveText}
              disabled={saving || !textContent.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving...' : 'Save Text'}
            </button>
            
            <button 
              onClick={handleTokenize}
              disabled={saving || !textContent.trim() || isTextDirty}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              title={isTextDirty ? "Please save text changes before tokenizing" : ""}
            >
              {saving ? 'Processing...' : 'Whitespace Tokenize'}
            </button>
            
            {tokens.length > 0 && (
              <button 
                onClick={handleClearTokens}
                disabled={saving}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                Clear Tokens
              </button>
            )}
            
            <div className="ml-auto text-sm font-medium text-gray-600">
              {tokens.length} token{tokens.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>

        <div className="border border-gray-200 rounded-md p-4 bg-gray-50">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Token Visualization</h3>
          <TokenVisualizer 
            text={textContent}
            originalText={originalTokenizedText}
            tokens={tokens}
            sentenceSpans={sentenceSpans}
            onTokenUpdate={handleTokenUpdate}
            onTokenDelete={handleTokenDelete}
            onTokenCreate={handleTokenCreate}
            onSentenceToggle={handleSentenceToggle}
          />
        </div>
      </div>

      <div className="text-center py-8 border-t border-gray-200">
        <Link 
          to={`/projects/${projectId}/documents/${documentId}/annotate`}
          className="inline-block px-6 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors font-medium"
        >
          Continue to Annotation →
        </Link>
      </div>
      
    </div>
  );
};