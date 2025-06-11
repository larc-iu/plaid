import React, { useState, useEffect } from 'react';

function ProjectsView({ client, onProjectSelect, onBack }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError('');
      const projectsData = await client.projects.list();
      setProjects(projectsData || []);
    } catch (err) {
      setError(`Failed to load projects: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const createProject = async (e) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      setCreating(true);
      setError('');
      
      // Create the project
      const project = await client.projects.create(newProjectName.trim());
      
      // Create required layers for the new project
      const textLayer = await client.textLayers.create(project.id, 'Primary Text');
      const tokenLayer = await client.tokenLayers.create(textLayer.id, 'Tokens');
      
      // Create POS span layer
      const posSpanLayer = await client.spanLayers.create(tokenLayer.id, 'POS Tags');
      await client.spanLayers.setConfig(posSpanLayer.id, 'pos_editor', 'type', 'pos_tags');
      
      // Create sentence boundary span layer
      const sentenceSpanLayer = await client.spanLayers.create(tokenLayer.id, 'Sentence Boundaries');
      await client.spanLayers.setConfig(sentenceSpanLayer.id, 'pos_editor', 'type', 'sentence_boundaries');
      
      setNewProjectName('');
      setShowCreateForm(false);
      await loadProjects(); // Reload the projects list
    } catch (err) {
      setError(`Failed to create project: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-lg">Loading projects...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Projects</h1>
        <div className="space-x-2">
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
          >
            {showCreateForm ? 'Cancel' : 'New Project'}
          </button>
          <button
            onClick={onBack}
            className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          >
            Logout
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
          <h2 className="text-xl font-semibold mb-4">Create New Project</h2>
          <form onSubmit={createProject} className="space-y-4">
            <div>
              <label htmlFor="projectName" className="block text-sm font-medium text-gray-700 mb-1">
                Project Name
              </label>
              <input
                type="text"
                id="projectName"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter project name"
                required
              />
            </div>
            <div className="flex space-x-2">
              <button
                type="submit"
                disabled={creating}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create Project'}
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
        {projects.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No projects found. Create a new project to get started.
          </div>
        ) : (
          projects.map((project) => (
            <div
              key={project.id}
              className="bg-white p-6 rounded-lg shadow-md hover:shadow-lg cursor-pointer transition-shadow"
              onClick={() => onProjectSelect(project)}
            >
              <h3 className="text-xl font-semibold text-blue-600 mb-2">{project.name}</h3>
              <p className="text-gray-600">Click to open project</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ProjectsView;