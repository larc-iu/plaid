import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export const ProjectList = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { client, logout } = useAuth();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="tw flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="tw mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
        <Button onClick={() => navigate('/projects/new')}>
          <Plus className="h-4 w-4" /> New Project
        </Button>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {projects.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No projects found</p>
          <p className="mt-1 text-sm">You don&apos;t have access to any projects yet.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className="cursor-pointer p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <h3 className="font-semibold">{project.name}</h3>
              <p className="mt-1 truncate text-sm text-muted-foreground">ID: {project.id}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
