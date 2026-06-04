import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { FileText, Users, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DocumentList } from './DocumentList';
import { AccessManagement } from './AccessManagement';
import { ProjectSettings } from './ProjectSettings';

export const ProjectDetail = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, client } = useAuth();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('documents');

  // Unified data fetching function with flexible options
  const fetchData = async (options = {}) => {
    const {
      includeProject = false,
      includeUsers = false,
      includeDocuments = false,
      showLoadingSpinner = false
    } = options;

    try {
      if (showLoadingSpinner) {
        setLoading(true);
      }
      
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      // Fetch project data (with documents if requested)
      if (includeProject) {
        const [projectData, docsList] = await Promise.all([
          client.projects.get(projectId),
          includeDocuments ? client.projects.listDocuments(projectId) : Promise.resolve(null),
        ]);
        setProject(projectData);

        if (includeDocuments) {
          setDocuments(docsList || []);
        }
      }
      
      // Fetch users if requested and user has permission
      if (includeUsers && (user.isAdmin || project?.maintainers?.includes(user.id))) {
        const usersData = await client.users.list();
        setUsers(usersData);
      }
      
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        navigate('/login');
        return;
      }
      setError('Failed to load data');
      console.error('Error fetching data:', err);
    } finally {
      if (showLoadingSpinner) {
        setLoading(false);
      }
    }
  };

  // Initial data load with full loading state
  const fetchInitialData = () => fetchData({
    includeProject: true,
    includeUsers: true,
    includeDocuments: true,
    showLoadingSpinner: true
  });

  // Update project data without loading spinner
  const updateProjectData = () => fetchData({
    includeProject: true,
    includeDocuments: true
  });

  // Handle document creation
  const handleDocumentCreated = (newDocument) => {
    setDocuments(prev => [...prev, newDocument]);
  };

  // Update users list without loading spinner
  const updateUsersData = () => fetchData({
    includeUsers: true
  });

  useEffect(() => {
    fetchInitialData();
  }, [projectId]);

  // Check if project needs setup and redirect if necessary
  useEffect(() => {
    if (project && !project.config?.plaid?.initialized) {
      navigate(`/projects/${projectId}/setup`, { replace: true });
    }
  }, [project, projectId, navigate]);

  // Check if current user can manage this project
  const canManageProject = () => {
    if (!user || !project) return false;
    return user.isAdmin || project.maintainers?.includes(user.id);
  };

  if (loading) {
    return (
      <div className="tw flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error || 'The requested project could not be found.'}
        </div>
      </div>
    );
  }

  const canManage = canManageProject();

  // NOTE: `.tw` is scoped to the shadcn chrome (header + tabs list) only. The
  // tab panels are still Mantine (DocumentList/AccessManagement/ProjectSettings)
  // and must stay OUTSIDE any `.tw` subtree, or the scoped reset clobbers their
  // styling (e.g. button backgrounds). Drop the wrapper when those migrate.
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="tw">
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground">Projects</Link>
          <span>/</span>
          <span className="text-foreground">{project.name}</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
        <p className="mb-6 mt-1 text-xs text-muted-foreground">{project.id}</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="tw">
          <TabsTrigger value="documents"><FileText className="h-4 w-4" /> Document List</TabsTrigger>
          {canManage && <TabsTrigger value="management"><Users className="h-4 w-4" /> Access Management</TabsTrigger>}
          {canManage && <TabsTrigger value="settings"><Settings className="h-4 w-4" /> Settings</TabsTrigger>}
        </TabsList>

        <TabsContent value="documents">
          <DocumentList
            documents={documents}
            projectId={projectId}
            client={client}
            onDocumentCreated={handleDocumentCreated}
          />
        </TabsContent>
        {canManage && (
          <TabsContent value="management">
            <AccessManagement
              project={project}
              users={users}
              user={user}
              projectId={projectId}
              client={client}
              onDataUpdate={updateProjectData}
              onUsersUpdate={updateUsersData}
            />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="settings">
            <ProjectSettings project={project} projectId={projectId} client={client} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};