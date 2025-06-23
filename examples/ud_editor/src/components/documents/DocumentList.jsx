import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import './DocumentList.css';

export const DocumentList = () => {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const { getClient } = useAuth();

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      // Fetch project with documents
      const projectData = await client.projects.get(projectId, true);
      setProject(projectData);
      setDocuments(projectData.documents || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Redirect to login instead of showing error
        window.location.href = '/login';
        return;
      }
      setError('Failed to load project and documents');
      console.error('Error fetching project:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjectAndDocuments();
  }, [projectId]);

  const handleDelete = async (documentId, documentName) => {
    if (!confirm(`Are you sure you want to delete document "${documentName}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const client = getClient();
      await client.documents.delete(documentId);
      await fetchProjectAndDocuments(); // Refresh the list
    } catch (err) {
      setError('Failed to delete document');
      console.error('Error deleting document:', err);
    }
  };

  const handleDocumentCreated = () => {
    setShowCreateForm(false);
    fetchProjectAndDocuments(); // Refresh the list
  };

  if (loading) {
    return <div className="loading">Loading documents...</div>;
  }

  if (!project) {
    return <div className="error-message">Project not found</div>;
  }

  return (
    <div className="document-list-container">
      <div className="breadcrumb">
        <Link to="/projects">Projects</Link>
        <span className="separator">/</span>
        <span>{project.name}</span>
      </div>

      <div className="document-list-header">
        <h2>Documents in {project.name}</h2>
        <button 
          className="create-button"
          onClick={() => setShowCreateForm(true)}
        >
          + New Document
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {showCreateForm && (
        <DocumentForm 
          projectId={projectId}
          onClose={() => setShowCreateForm(false)}
          onSuccess={handleDocumentCreated}
        />
      )}

      {documents.length === 0 ? (
        <div className="empty-state">
          <p>No documents yet. Create your first document to start annotating!</p>
        </div>
      ) : (
        <div className="document-grid">
          {documents.map(document => (
            <div key={document.id} className="document-card">
              <h3>{document.name}</h3>
              <div className="document-metadata">
                <span className="document-id">ID: {document.id}</span>
              </div>
              <div className="document-actions">
                <Link 
                  to={`/projects/${projectId}/documents/${document.id}/edit`}
                  className="edit-button"
                >
                  Edit Text
                </Link>
                <Link 
                  to={`/projects/${projectId}/documents/${document.id}/annotate`}
                  className="annotate-button"
                >
                  Annotate
                </Link>
                <button 
                  className="delete-button"
                  onClick={() => handleDelete(document.id, document.name)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};