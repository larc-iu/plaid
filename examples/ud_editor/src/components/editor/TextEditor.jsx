import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { TokenVisualizer } from './TokenVisualizer';
import './TextEditor.css';

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
    return <div className="loading">Loading document...</div>;
  }

  if (!document || !project) {
    return <div className="error-message">Document or project not found</div>;
  }

  const { tokens } = getLayerData();

  return (
    <div className="text-editor-container">
      <div className="breadcrumb">
        <Link to="/projects">Projects</Link>
        <span className="separator">/</span>
        <Link to={`/projects/${projectId}/documents`}>{project?.name}</Link>
        <span className="separator">/</span>
        <span>{document?.name}</span>
        <span className="separator">/</span>
        <span>Text Editor</span>
      </div>

      <div className="editor-header">
        <h2>Text Editor: {document?.name}</h2>
        <div className="editor-status">
          {saving && <span className="saving">Processing...</span>}
          {!saving && lastSaved && (
            <span className="saved">
              Saved: {lastSaved.toLocaleTimeString()}
            </span>
          )}
          {!saving && !lastSaved && textContent && (
            <span className="unsaved">Unsaved changes</span>
          )}
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="editor-content">
        <div className="text-section">
          <h3>Text Content</h3>
          <textarea
            className="text-input"
            value={textContent}
            onChange={handleTextChange}
            placeholder="Enter your text here. Use multiple newlines to separate sentences.

Example:
The quick brown fox jumps over the lazy dog.
This is a second sentence for testing."
            rows={12}
          />
          
          <div className="text-controls">
            <button 
              onClick={saveText}
              disabled={saving || !textContent.trim()}
              className="save-button"
            >
              {saving ? 'Saving...' : 'Save Text'}
            </button>
            
            <button 
              onClick={handleTokenize}
              disabled={saving || !textContent.trim()}
              className="tokenize-button"
            >
              {saving ? 'Processing...' : 'Whitespace Tokenize'}
            </button>
            
            {tokens.length > 0 && (
              <button 
                onClick={handleClearTokens}
                disabled={saving}
                className="clear-button"
              >
                Clear Tokens
              </button>
            )}
            
            <div className="token-count">
              {tokens.length} token{tokens.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>

        <div className="visualization-section">
          <h3>Token Visualization</h3>
          <TokenVisualizer 
            text={textContent}
            tokens={tokens}
          />
        </div>
      </div>

      <div className="editor-actions">
        <Link 
          to={`/projects/${projectId}/documents/${documentId}/annotate`}
          className="annotate-button"
        >
          Continue to Annotation →
        </Link>
      </div>
      
      <div className="demo-note">
        <h4>Real Plaid Integration</h4>
        <p>
          This text editor now uses real Plaid APIs! Use "Save Text" to persist your changes 
          to the Plaid database, then "Whitespace Tokenize" to create actual tokens with 
          proper IDs and relationships. All changes are persisted and will be available 
          when you return to this document.
        </p>
      </div>
    </div>
  );
};