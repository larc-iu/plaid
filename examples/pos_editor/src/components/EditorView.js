import React, { useState, useEffect } from 'react';

function EditorView({ client, project, document, onBack }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  
  // Layer data
  const [textLayer, setTextLayer] = useState(null);
  const [tokenLayer, setTokenLayer] = useState(null);
  const [posSpanLayer, setPosSpanLayer] = useState(null);
  const [sentenceSpanLayer, setSentenceSpanLayer] = useState(null);
  
  // Document data
  const [text, setText] = useState('');
  const [tokens, setTokens] = useState([]);
  const [posSpans, setPosSpans] = useState([]);
  const [sentenceSpans, setSentenceSpans] = useState([]);
  
  // UI state
  const [editingToken, setEditingToken] = useState(null);

  useEffect(() => {
    loadDocumentData();
    
    // Cleanup timeouts on unmount
    return () => {
      clearTimeout(window.textUpdateTimeout);
      clearTimeout(window.posTagTimeout);
    };
  }, [document]);

  const loadDocumentData = async () => {
    try {
      setLoading(true);
      setError('');
      
      // Get document with full layer tree
      const documentData = await client.documents.get(document.id, true);
      
      // Extract layers from document structure
      const textLayers = documentData.textLayers || [];
      const foundTextLayer = textLayers[0]; // Assume first text layer
      
      if (!foundTextLayer) {
        throw new Error('No text layer found in document');
      }
      
      setTextLayer(foundTextLayer);
      
      const tokenLayers = foundTextLayer.tokenLayers || [];
      const foundTokenLayer = tokenLayers[0]; // Assume first token layer
      
      if (!foundTokenLayer) {
        throw new Error('No token layer found');
      }
      
      setTokenLayer(foundTokenLayer);
      
      // Find span layers by config
      const spanLayers = foundTokenLayer.spanLayers || [];
      const foundPosLayer = spanLayers.find(layer => {
        const config = layer.config && layer.config['pos_editor'];
        return config && config.type === 'pos_tags';
      });
      const foundSentenceLayer = spanLayers.find(layer => {
        const config = layer.config && layer.config['pos_editor'];
        return config && config.type === 'sentence_boundaries';
      });
      
      setPosSpanLayer(foundPosLayer);
      setSentenceSpanLayer(foundSentenceLayer);
      
      // Load document text
      const documentText = foundTextLayer.text;
      setText(documentText ? documentText.body : '');
      
      // Load tokens (already filtered to this document)
      const documentTokens = foundTokenLayer.tokens || [];
      setTokens(documentTokens);
      
      // Load spans (already filtered to this document)
      if (foundPosLayer) {
        setPosSpans(foundPosLayer.spans || []);
      }
      
      if (foundSentenceLayer) {
        setSentenceSpans(foundSentenceLayer.spans || []);
      }
      
    } catch (err) {
      setError(`Failed to load document: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const updateText = (newText) => {
    // Update UI immediately
    setText(newText);
    
    // Debounce the API calls
    clearTimeout(window.textUpdateTimeout);
    window.textUpdateTimeout = setTimeout(async () => {
      try {
        setSaving(true);
        
        // Update the text content
        if (textLayer && textLayer.text) {
          const textObj = textLayer.text;
          await client.texts.update(textObj.id, newText);
        } else if (textLayer) {
          await client.texts.create(textLayer.id, document.id, newText);
        }
        
        // Auto-tokenize: create tokens for new whitespace-separated words
        if (tokenLayer) {
          await autoTokenize(newText);
        }
        
      } catch (err) {
        setError(`Failed to update text: ${err.message}`);
      } finally {
        setSaving(false);
      }
    }, 1000); // Wait 1 second after user stops typing
  };

  const loadTokensOnly = async () => {
    try {
      if (!tokenLayer) return;
      
      // Get document with full layer tree
      const documentData = await client.documents.get(document.id, true);
      
      // Extract layers from document structure
      const textLayers = documentData.textLayers || [];
      const foundTextLayer = textLayers[0];
      if (!foundTextLayer) return;
      
      const tokenLayers = foundTextLayer.tokenLayers || [];
      const foundTokenLayer = tokenLayers[0];
      if (!foundTokenLayer) return;
      
      // Load tokens (already filtered to this document)
      const documentTokens = foundTokenLayer.tokens || [];
      setTokens(documentTokens);
      
      // Load spans (already filtered to this document) 
      const spanLayers = foundTokenLayer.spanLayers || [];
      const foundPosLayer = spanLayers.find(layer => {
        const config = layer.config && layer.config['pos_editor'];
        return config && config.type === 'pos_tags';
      });
      const foundSentenceLayer = spanLayers.find(layer => {
        const config = layer.config && layer.config['pos_editor'];
        return config && config.type === 'sentence_boundaries';
      });
      
      if (foundPosLayer) {
        setPosSpanLayer(foundPosLayer);
        setPosSpans(foundPosLayer.spans || []);
      }
      
      if (foundSentenceLayer) {
        setSentenceSpanLayer(foundSentenceLayer);
        setSentenceSpans(foundSentenceLayer.spans || []);
      }
      
    } catch (err) {
      console.warn('Failed to reload tokens:', err);
    }
  };

  const autoTokenize = async (textContent) => {
    if (!tokenLayer) return;
    
    // Simple whitespace tokenization
    const words = textContent.split(/\s+/).filter(word => word.length > 0);
    let position = 0;
    
    for (const word of words) {
      const begin = textContent.indexOf(word, position);
      const end = begin + word.length;
      
      // Check if token already exists at this position
      const existingToken = tokens.find(token => token.begin === begin && token.end === end);
      
      if (!existingToken && textLayer.text) {
        const textObj = textLayer.text;
        try {
          await client.tokens.create(tokenLayer.id, textObj.id, begin, end);
        } catch (err) {
          console.warn('Failed to create token:', err);
        }
      }
      
      position = end;
    }
    
    // Reload only tokens, not the full document
    await loadTokensOnly();
  };

  const updateToken = async (tokenId, newBegin, newEnd) => {
    try {
      setSaving(true);
      await client.tokens.update(tokenId, { begin: newBegin, end: newEnd });
      await loadTokensOnly();
    } catch (err) {
      setError(`Failed to update token: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleSentenceBoundary = async (tokenId) => {
    if (!sentenceSpanLayer) return;
    
    try {
      setSaving(true);
      
      // Check if span already exists for this token
      const existingSpan = sentenceSpans.find(span => span.id && span.id.tokens && span.id.tokens.includes(tokenId));
      
      if (existingSpan) {
        // Remove the span
        await client.spans.delete(existingSpan.id.id);
      } else {
        // Create new span
        await client.spans.create(sentenceSpanLayer.id, [tokenId], 'sentence-start');
      }
      
      await loadTokensOnly();
    } catch (err) {
      setError(`Failed to toggle sentence boundary: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const updatePosTagImmediate = (tokenId, posTag) => {
    // Update UI state immediately for responsiveness
    setPosSpans(prev => {
      const existingSpanIndex = prev.findIndex(span => span.id && span.id.tokens && span.id.tokens.includes(tokenId));
      
      if (existingSpanIndex >= 0) {
        if (posTag === '') {
          // Remove span if empty
          return prev.filter((_, index) => index !== existingSpanIndex);
        } else {
          // Update existing span
          const updated = [...prev];
          updated[existingSpanIndex] = {
            ...updated[existingSpanIndex],
            id: {
              ...updated[existingSpanIndex].id,
              value: posTag
            }
          };
          return updated;
        }
      } else if (posTag !== '') {
        // Add new span (we'll get the real ID from the server later)
        return [...prev, {
          id: {
            id: `temp-${tokenId}`,
            tokens: [tokenId],
            value: posTag
          }
        }];
      }
      return prev;
    });
    
    // Debounce the API call
    clearTimeout(window.posTagTimeout);
    window.posTagTimeout = setTimeout(() => updatePosTagDebounced(tokenId, posTag), 500);
  };

  const updatePosTagDebounced = async (tokenId, posTag) => {
    if (!posSpanLayer) return;
    
    try {
      setSaving(true);
      
      // Check if POS span already exists for this token (excluding temporary ones)
      const existingSpan = posSpans.find(span => 
        span.id && 
        span.id.tokens && 
        span.id.tokens.includes(tokenId) &&
        !span.id.id.startsWith('temp-')
      );
      
      if (existingSpan) {
        if (posTag === '') {
          // Delete span if empty
          await client.spans.delete(existingSpan.id.id);
        } else {
          // Update existing span
          await client.spans.update(existingSpan.id.id, posTag);
        }
      } else if (posTag !== '') {
        // Create new span (this handles both new spans and temporary spans)
        await client.spans.create(posSpanLayer.id, [tokenId], posTag);
      }
      
      await loadTokensOnly();
    } catch (err) {
      setError(`Failed to update POS tag: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const getTokenText = (token) => {
    return text.slice(token.begin, token.end);
  };

  const getPosTagForToken = (tokenId) => {
    const span = posSpans.find(span => span.id && span.id.tokens && span.id.tokens.includes(tokenId));
    console.log('getPosTagForToken:', { tokenId, posSpans, span, value: span ? span.id.value : '' });
    return span ? span.id.value : '';
  };

  const isSentenceStart = (tokenId) => {
    return sentenceSpans.some(span => span.id && span.id.tokens && span.id.tokens.includes(tokenId));
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-lg">Loading document...</div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Document Editor</h1>
          <p className="text-gray-600 mt-1">
            Project: {project.name} | Document: {document.name}
          </p>
        </div>
        <div className="space-x-2">
          {saving && <span className="text-blue-600">Saving...</span>}
          <button
            onClick={onBack}
            className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          >
            Back to Documents
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Text Editor */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-xl font-semibold mb-4">Text Content</h2>
          <textarea
            value={text}
            onChange={(e) => updateText(e.target.value)}
            className="w-full h-64 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder="Enter your text here..."
          />
          <p className="text-sm text-gray-600 mt-2">
            Text is automatically tokenized on whitespace when you type.
          </p>
        </div>

        {/* Token and Annotation Editor */}
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-xl font-semibold mb-4">Tokens & Annotations</h2>
          
          {tokens.length === 0 ? (
            <div className="text-gray-500 text-center py-8">
              No tokens found. Add some text to automatically create tokens.
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {tokens.map((token, index) => (
                <div key={token.id} className="border rounded p-2">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-semibold">
                      {isSentenceStart(token.id) && (
                        <span className="text-red-600 mr-1">|</span>
                      )}
                      {getTokenText(token)}
                    </span>
                    <button
                      onClick={() => toggleSentenceBoundary(token.id)}
                      className={`text-xs px-2 py-1 rounded ${
                        isSentenceStart(token.id)
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {isSentenceStart(token.id) ? 'Remove Boundary' : 'Mark Sentence Start'}
                    </button>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <label className="text-sm text-gray-600 min-w-0">POS:</label>
                    <input
                      type="text"
                      value={getPosTagForToken(token.id)}
                      onChange={(e) => updatePosTagImmediate(token.id, e.target.value)}
                      className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="Enter POS tag"
                    />
                  </div>
                  
                  <div className="text-xs text-gray-500 mt-1">
                    Position: {token.begin}-{token.end}
                  </div>
                </div>
              ))}
            </div>
          )}
          
          <div className="mt-4 text-sm text-gray-600 space-y-1">
            <p><strong>Instructions:</strong></p>
            <p>• Red bars (|) indicate sentence boundaries</p>
            <p>• Click "Mark Sentence Start" to toggle sentence boundaries</p>
            <p>• Enter POS tags in the input fields</p>
            <p>• Changes are saved automatically</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EditorView;