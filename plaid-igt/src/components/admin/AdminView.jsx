import { Navigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useTabParam, tabTo } from '../../hooks/useTabParam';
import { AdminUsers } from './AdminUsers';
import { AdminInvites } from './AdminInvites';
import { AdminActivity } from './AdminActivity';
import { AdminProjects } from './AdminProjects';
import { AdminVocabularies } from './AdminVocabularies';
import { AdminServices } from './AdminServices';
import { AdminAssistant } from './AdminAssistant';
import { AdminServer } from './AdminServer';

// The whole-server view, for whoever runs this instance. Everything a project
// maintainer needs lives on the project; what is here is the part that spans
// projects or sits below them.
const TABS = [
  'users',
  'invites',
  'activity',
  'projects',
  'vocabularies',
  'services',
  'assistant',
  'server',
];

export const AdminView = () => {
  const { user, client } = useAuth();
  const [tab, setTab] = useTabParam(TABS, 'users');
  useDocumentTitle('Administration');

  // Not a permission check the server relies on — every endpoint behind this
  // screen is admin-gated on its own. This only keeps a non-admin from
  // landing on a page of 403s.
  if (user && !user.isAdmin) return <Navigate to="/projects" replace />;
  if (!client) return null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="pb-4 text-2xl font-bold">Administration</h1>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="users" to={tabTo('/admin', 'users', 'users')}>
            Users
          </TabsTrigger>
          <TabsTrigger value="invites" to={tabTo('/admin', 'invites', 'users')}>
            Invites
          </TabsTrigger>
          <TabsTrigger value="activity" to={tabTo('/admin', 'activity', 'users')}>
            Activity
          </TabsTrigger>
          <TabsTrigger value="projects" to={tabTo('/admin', 'projects', 'users')}>
            Projects
          </TabsTrigger>
          <TabsTrigger value="vocabularies" to={tabTo('/admin', 'vocabularies', 'users')}>
            Vocabularies
          </TabsTrigger>
          <TabsTrigger value="services" to={tabTo('/admin', 'services', 'users')}>
            Services
          </TabsTrigger>
          <TabsTrigger value="assistant" to={tabTo('/admin', 'assistant', 'users')}>
            Assistant
          </TabsTrigger>
          <TabsTrigger value="server" to={tabTo('/admin', 'server', 'users')}>
            Server
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <AdminUsers client={client} currentUser={user} />
        </TabsContent>
        <TabsContent value="invites">
          <AdminInvites client={client} />
        </TabsContent>
        <TabsContent value="activity">
          <AdminActivity client={client} />
        </TabsContent>
        <TabsContent value="projects">
          <AdminProjects client={client} currentUser={user} />
        </TabsContent>
        <TabsContent value="vocabularies">
          <AdminVocabularies client={client} />
        </TabsContent>
        <TabsContent value="services">
          <AdminServices client={client} />
        </TabsContent>
        <TabsContent value="assistant">
          <AdminAssistant client={client} />
        </TabsContent>
        <TabsContent value="server">
          <AdminServer client={client} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
