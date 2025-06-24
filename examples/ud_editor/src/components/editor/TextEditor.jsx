import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { TokenVisualizer } from './TokenVisualizer';

export const TextEditor = () => {
  const { projectId, documentId } = useParams();
  const [document, setDocument] = useState(null);
  const [project, setProject] = useState(null);
  const [textContent, setTextContent] = useState('');
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
    return { textLayer, text, tokenLayer, tokens };
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
      // Refresh document to get updated data
      await fetchData();
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
      
      // Clear existing tokens first
      if (tokens.length > 0) {
        await Promise.all(tokens.map(token => 
          client.tokens.delete(token.id)
        ));
      }
      
      // Simple whitespace tokenization
      const tokenData = [];
      let currentIndex = 0;
      let precedence = 1;
      
      // Split by whitespace but preserve positions
      const parts = textContent.split(/(\s+)/);
      
      for (const part of parts) {
        if (part.trim()) {
          tokenData.push({
            begin: currentIndex,
            end: currentIndex + part.length,
            precedence: precedence++
          });
        }
        currentIndex += part.length;
      }

      // Create tokens via Plaid API
      for (const tokenInfo of tokenData) {
        await client.tokens.create(
          tokenLayer.id,
          text.id,
          tokenInfo.begin,
          tokenInfo.end,
          tokenInfo.precedence
        );
      }

      // Refresh document to get updated tokens
      await fetchData();
      
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
      
      // Delete all tokens via API
      await Promise.all(tokens.map(token => 
        client.tokens.delete(token.id)
      ));
      
      // Refresh document
      await fetchData();
      
    } catch (err) {
      setError('Failed to clear tokens: ' + (err.message || 'Unknown error'));
      console.error('Error clearing tokens:', err);
    } finally {
      setSaving(false);
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

  const { tokens } = getLayerData();

  return (
    <div>
      <nav className="flex items-center text-sm text-gray-500 mb-6">
        <Link to="/projects" className="text-blue-600 hover:text-blue-800">Projects</Link>
        <span className="mx-2">/</span>
        <Link to={`/projects/${projectId}/documents`} className="text-blue-600 hover:text-blue-800">{project?.name}</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">{document?.name}</span>
        <span className="mx-2">/</span>
        <span className="text-gray-900">Text Editor</span>
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
          {!saving && !lastSaved && textContent && (
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
              disabled={saving || !textContent.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
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
            tokens={tokens}
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
      
      <div className="mt-8 p-6 bg-blue-50 border-l-4 border-blue-400 rounded-md">
        <h4 className="font-semibold text-blue-900 mb-2">Real Plaid Integration</h4>
        <p className="text-blue-800 text-sm leading-relaxed">
          This text editor now uses real Plaid APIs! Use "Save Text" to persist your changes 
          to the Plaid database, then "Whitespace Tokenize" to create actual tokens with 
          proper IDs and relationships. All changes are persisted and will be available 
          when you return to this document.
        </p>
      </div>
    </div>
  );
};