import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectForm } from './ProjectForm';
import './ProjectList.css';

export const ProjectList = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const { getClient } = useAuth();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Redirect to login instead of showing error
        window.location.href = '/login';
        return;
      }
      setError('Failed to load projects');
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleDelete = async (projectId, projectName) => {
    if (!confirm(`Are you sure you want to delete project "${projectName}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const client = getClient();
      await client.projects.delete(projectId);
      await fetchProjects(); // Refresh the list
    } catch (err) {
      setError('Failed to delete project');
      console.error('Error deleting project:', err);
    }
  };

  const handleProjectCreated = () => {
    setShowCreateForm(false);
    fetchProjects(); // Refresh the list
  };

  if (loading) {
    return <div className="loading">Loading projects...</div>;
  }

  return (
    <div className="project-list-container">
      <div className="project-list-header">
        <h2>Projects</h2>
        <button 
          className="create-button"
          onClick={() => setShowCreateForm(true)}
        >
          + New UD Project
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {showCreateForm && (
        <ProjectForm 
          onClose={() => setShowCreateForm(false)}
          onSuccess={handleProjectCreated}
        />
      )}

      {projects.length === 0 ? (
        <div className="empty-state">
          <p>No projects yet. Create your first UD project to get started!</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map(project => (
            <div key={project.id} className="project-card">
              <h3>{project.name}</h3>
              <div className="project-metadata">
                <span className="project-id">ID: {project.id}</span>
                {project.documents && (
                  <span className="document-count">
                    {project.documents.length} document{project.documents.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div className="project-actions">
                <Link 
                  to={`/projects/${project.id}/documents`}
                  className="view-button"
                >
                  View Documents
                </Link>
                <button 
                  className="delete-button"
                  onClick={() => handleDelete(project.id, project.name)}
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