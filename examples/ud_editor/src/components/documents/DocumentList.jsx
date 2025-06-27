import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import { ImportModal } from './ImportModal';

export const DocumentList = () => {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const { user, getClient } = useAuth();

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

  const handleImportSuccess = () => {
    setShowImportModal(false);
    fetchProjectAndDocuments(); // Refresh the list
  };

  // Check if user can manage this project (admin or maintainer)
  const canManageProject = () => {
    if (!user || !project) return false;
    return user.isAdmin || project.maintainers?.includes(user.id);
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading documents...</div>;
  }

  if (!project) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">Project not found</p>
      </div>
    );
  }

  return (
    <div>
      <nav className="flex items-center text-sm text-gray-500 mb-6">
        <Link to="/projects" className="text-blue-600 hover:text-blue-800">Projects</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">{project.name}</span>
      </nav>

      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Documents in {project.name}</h2>
        <div className="flex gap-3">
          {canManageProject() && (
            <Link
              to={`/projects/${projectId}/management`}
              className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors text-sm font-medium"
            >
              Project Management
            </Link>
          )}
          <button 
            className="px-4 py-2 bg-gray-500 text-white rounded-md hover:bg-gray-600 transition-colors text-sm font-medium"
            onClick={() => setShowImportModal(true)}
          >
            Import
          </button>
          <button 
            className="px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800 transition-colors text-sm font-medium"
            onClick={() => setShowCreateForm(true)}
          >
            + New Document
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 mb-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {showCreateForm && (
        <DocumentForm 
          projectId={projectId}
          onClose={() => setShowCreateForm(false)}
          onSuccess={handleDocumentCreated}
        />
      )}

      {showImportModal && (
        <ImportModal 
          projectId={projectId}
          onClose={() => setShowImportModal(false)}
          onSuccess={handleImportSuccess}
        />
      )}

      {documents.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">No documents yet. Create your first document to start annotating!</p>
        </div>
      ) : (
        <div className="bg-white shadow overflow-hidden sm:rounded-md">
          <ul className="divide-y divide-gray-200">
            {documents.sort((d1, d2) => d1.name < d2.name ? -1 : d1.name > d2.name ? 1 : 0).map(document => (
              <li key={document.id} className="hover:bg-gray-50 transition-colors">
                <div className="px-4 py-4 sm:px-6">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h3 className="text-lg font-medium text-gray-900">{document.name}</h3>
                      <p className="mt-1 text-sm text-gray-500">ID: {document.id}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link 
                        to={`/projects/${projectId}/documents/${document.id}/edit`}
                        className="px-3 py-1.5 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                      >
                        Edit Text
                      </Link>
                      <Link 
                        to={`/projects/${projectId}/documents/${document.id}/annotate`}
                        className="px-3 py-1.5 text-sm text-green-600 hover:text-green-800 hover:bg-green-50 rounded-md transition-colors"
                      >
                        Annotate
                      </Link>
                      <button 
                        className="px-3 py-1.5 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 rounded-md transition-colors"
                        onClick={() => handleDelete(document.id, document.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};