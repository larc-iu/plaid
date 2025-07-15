import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Modal, Button, FormField, ErrorMessage } from '../ui';

export const DocumentForm = ({ projectId, isOpen, onClose, onSuccess }) => {
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
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Document" size="small">
      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <ErrorMessage message={error} />
          
          <FormField
            label="Document Name"
            name="documentName"
            value={documentName}
            onChange={(e) => setDocumentName(e.target.value)}
            placeholder="Enter document name"
            required
            autoFocus
            disabled={loading}
          />
          
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
              type="submit" 
              variant="dark"
              disabled={loading}
              isLoading={loading}
            >
              {loading ? 'Creating...' : 'Create Document'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
};