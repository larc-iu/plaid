import { Navigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@ui/components/ui/tabs';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useTabParam } from '../../hooks/useTabParam';
import { AdminUsers } from './AdminUsers';
import { AdminInvites } from './AdminInvites';
import { AdminActivity } from './AdminActivity';
import { AdminProjects } from './AdminProjects';
import { AdminVocabularies } from './AdminVocabularies';
import { AdminServices } from './AdminServices';
import { AdminAssistant } from './AdminAssistant';
import { AdminServer } from './AdminServer';
import { AdminLogs } from './AdminLogs';

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
  'logs',
];

export const AdminView = () => {
  const { user, client } = useAuth();
  const [tab, setTab, tabHref] = useTabParam(TABS, 'users');
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
          <TabsTrigger value="users" to={tabHref('/admin', 'users')}>
            Users
          </TabsTrigger>
          <TabsTrigger value="invites" to={tabHref('/admin', 'invites')}>
            Invites
          </TabsTrigger>
          <TabsTrigger value="activity" to={tabHref('/admin', 'activity')}>
            Activity
          </TabsTrigger>
          <TabsTrigger value="projects" to={tabHref('/admin', 'projects')}>
            Projects
          </TabsTrigger>
          <TabsTrigger value="vocabularies" to={tabHref('/admin', 'vocabularies')}>
            Vocabularies
          </TabsTrigger>
          <TabsTrigger value="services" to={tabHref('/admin', 'services')}>
            Services
          </TabsTrigger>
          <TabsTrigger value="assistant" to={tabHref('/admin', 'assistant')}>
            Assistant
          </TabsTrigger>
          <TabsTrigger value="server" to={tabHref('/admin', 'server')}>
            Server
          </TabsTrigger>
          <TabsTrigger value="logs" to={tabHref('/admin', 'logs')}>
            Logs
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
        <TabsContent value="logs">
          <AdminLogs client={client} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
