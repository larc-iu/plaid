import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Modal, Button, FormField, ErrorMessage } from '../ui';

export const ProjectForm = ({ isOpen, onClose, onSuccess }) => {
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
    <Modal isOpen={isOpen} onClose={onClose} title="Create New UD Project" size="small">
      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <ErrorMessage message={error} />
          
          <FormField
            label="Project Name"
            name="projectName"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Enter project name"
            required
            autoFocus
            disabled={loading}
          />
          
          <div className="bg-gray-50 rounded-md p-4 text-sm text-gray-600">
            This will create a new project with all necessary layers for Universal Dependencies annotation:
            <ul className="mt-2 ml-4 list-disc space-y-1">
              <li>Text and Token layers</li>
              <li>Span layers for: Lemma, UPOS, XPOS, Features, etc.</li>
              <li>Relation layer for dependency parsing</li>
            </ul>
          </div>
          
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
              {loading ? 'Creating...' : 'Create Project'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
};