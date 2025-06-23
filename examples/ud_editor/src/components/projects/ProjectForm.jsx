import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './ProjectForm.css';

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
    <div className="project-form-overlay">
      <div className="project-form">
        <h3>Create New UD Project</h3>
        <form onSubmit={handleSubmit}>
          {error && <div className="error-message">{error}</div>}
          
          <div className="form-group">
            <label htmlFor="projectName">Project Name</label>
            <input
              id="projectName"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Enter project name"
              required
              autoFocus
              disabled={loading}
            />
          </div>
          
          <div className="form-info">
            This will create a new project with all necessary layers for Universal Dependencies annotation:
            <ul>
              <li>Text and Token layers</li>
              <li>Span layers for: Lemma, UPOS, XPOS, Features, etc.</li>
              <li>Relation layer for dependency parsing</li>
            </ul>
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
              {loading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};