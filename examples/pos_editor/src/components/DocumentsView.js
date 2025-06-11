import React, { useState, useEffect } from 'react';

function DocumentsView({ client, project, onDocumentSelect, onBack }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDocumentName, setNewDocumentName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadDocuments();
  }, [project]);

  const loadDocuments = async () => {
    try {
      setLoading(true);
      setError('');
      
      // Get full project details which should include documents
      const projectData = await client.projects.get(project.id, true);
      setDocuments(projectData.documents || []);
    } catch (err) {
      setError(`Failed to load documents: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const createDocument = async (e) => {
    e.preventDefault();
    if (!newDocumentName.trim()) return;

    try {
      setCreating(true);
      setError('');
      
      const document = await client.documents.create(project.id, newDocumentName.trim());
      
      setNewDocumentName('');
      setShowCreateForm(false);
      await loadDocuments(); // Reload the documents list
    } catch (err) {
      setError(`Failed to create document: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-lg">Loading documents...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Documents</h1>
          <p className="text-gray-600 mt-1">Project: {project.name}</p>
        </div>
        <div className="space-x-2">
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
          >
            {showCreateForm ? 'Cancel' : 'New Document'}
          </button>
          <button
            onClick={onBack}
            className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          >
            Back to Projects
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {showCreateForm && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-4">Create New Document</h2>
          <form onSubmit={createDocument} className="space-y-4">
            <div>
              <label htmlFor="documentName" className="block text-sm font-medium text-gray-700 mb-1">
                Document Name
              </label>
              <input
                type="text"
                id="documentName"
                value={newDocumentName}
                onChange={(e) => setNewDocumentName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter document name"
                required
              />
            </div>
            <div className="flex space-x-2">
              <button
                type="submit"
                disabled={creating}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create Document'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid gap-4">
        {documents.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No documents found. Create a new document to get started.
          </div>
        ) : (
          documents.map((document) => (
            <div
              key={document.id}
              className="bg-white p-6 rounded-lg shadow-md hover:shadow-lg cursor-pointer transition-shadow"
              onClick={() => onDocumentSelect(document)}
            >
              <h3 className="text-xl font-semibold text-blue-600 mb-2">{document.name}</h3>
              <p className="text-gray-600">Click to open document</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default DocumentsView;