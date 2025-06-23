import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './DocumentForm.css';

export const DocumentForm = ({ projectId, onClose, onSuccess }) => {
  const [documentName, setDocumentName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!documentName.trim()) {
      setError('Document name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const client = getClient();
      await client.documents.create(projectId, documentName);
      onSuccess();
    } catch (err) {
      setError('Failed to create document');
      console.error('Error creating document:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="document-form-overlay">
      <div className="document-form">
        <h3>Create New Document</h3>
        <form onSubmit={handleSubmit}>
          {error && <div className="error-message">{error}</div>}
          
          <div className="form-group">
            <label htmlFor="documentName">Document Name</label>
            <input
              id="documentName"
              type="text"
              value={documentName}
              onChange={(e) => setDocumentName(e.target.value)}
              placeholder="Enter document name"
              required
              autoFocus
              disabled={loading}
            />
          </div>
          
          <div className="form-actions">
            <button 
              type="button" 
              onClick={onClose}
              disabled={loading}
              className="cancel-button"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              disabled={loading}
              className="submit-button"
            >
              {loading ? 'Creating...' : 'Create Document'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};