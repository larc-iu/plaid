import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export const ProjectForm = ({ onClose, onSuccess }) => {
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  const createProjectWithLayers = async () => {
    const client = getClient();
    
    // 1. Create project
    const project = await client.projects.create(projectName);
    
    // 2. Create text layer
    const textLayer = await client.textLayers.create(project.id, 'Text');
    
    // 3. Create token layer
    const tokenLayer = await client.tokenLayers.create(textLayer.id, 'Token');
    
    // 4. Create all span layers
    const spanLayerNames = [
      'Ellipsis Form',
      'Multi-word Tokens',
      'Lemma',
      'XPOS',
      'UPOS',
      'Features',
      'Head',
      'Sentence'
    ];

    const spanLayers = [];
    // We need to do this sequentially or else it'll fail due to current implementation limitations
    for (const name of spanLayerNames) {
      spanLayers.push(await client.spanLayers.create(tokenLayer.id, name));
    }

    // 5. Create relation layer (attached to Lemma layer)
    const lemmaLayer = spanLayers[2];
    await client.relationLayers.create(lemmaLayer.id, 'Relation');
    
    return project;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!projectName.trim()) {
      setError('Project name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await createProjectWithLayers();
      onSuccess();
    } catch (err) {
      setError('Failed to create project with layers');
      console.error('Error creating project:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Create New UD Project</h3>
        <form onSubmit={handleSubmit}>
          {error && (
            <div className="rounded-md bg-red-50 p-4 mb-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
          
          <div className="mb-4">
            <label htmlFor="projectName" className="block text-sm font-medium text-gray-700 mb-1">
              Project Name
            </label>
            <input
              id="projectName"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Enter project name"
              required
              autoFocus
              disabled={loading}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>
          
          <div className="bg-gray-50 rounded-md p-4 mb-6 text-sm text-gray-600">
            This will create a new project with all necessary layers for Universal Dependencies annotation:
            <ul className="mt-2 ml-4 list-disc space-y-1">
              <li>Text and Token layers</li>
              <li>Span layers for: Lemma, UPOS, XPOS, Features, etc.</li>
              <li>Relation layer for dependency parsing</li>
            </ul>
          </div>
          
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
              type="submit" 
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-white bg-gray-900 border border-transparent rounded-md hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};