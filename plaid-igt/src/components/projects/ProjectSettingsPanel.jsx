import { Users, KeyRound, Plug, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AccessManagement } from './AccessManagement';
import { ProjectAccessTokens } from './ProjectAccessTokens';
import { ServicesSettings } from './settings/ServicesSettings';
import { ProjectSettings } from './ProjectSettings';

const SECTIONS = [
  { value: 'access', label: 'Access Management', icon: Users },
  { value: 'tokens', label: 'Access Tokens', icon: KeyRound },
  { value: 'services', label: 'Services', icon: Plug },
  { value: 'settings', label: 'Settings', icon: Settings },
];

// The Settings tab's body: project administration as a vertical, left-side tab
// group (Radix Tabs in vertical orientation). Route-backed by the caller — the
// active section follows /access, /tokens, /services, /settings — so deep links
// and the browser back button keep working.
export const ProjectSettingsPanel = ({ project, projectId, client, user, section, onSectionChange, onProjectUpdate }) => {
  return (
    <Tabs
      orientation="vertical"
      value={section}
      onValueChange={onSectionChange}
      className="flex flex-col gap-6 sm:flex-row sm:items-start"
    >
      <TabsList className="h-auto w-full shrink-0 flex-col items-stretch justify-start gap-0.5 border-b-0 bg-transparent p-0 sm:w-52 sm:border-r sm:pr-3">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <TabsTrigger
              key={s.value}
              value={s.value}
              className="w-full justify-start gap-2 rounded-md border-b-0 px-3 py-2 data-[state=active]:bg-muted data-[state=active]:text-foreground"
            >
              <Icon className="h-4 w-4 shrink-0" /> {s.label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="min-w-0 flex-1">
        <TabsContent value="access" className="mt-0">
          <AccessManagement
            project={project}
            user={user}
            projectId={projectId}
            client={client}
            onDataUpdate={onProjectUpdate}
          />
        </TabsContent>
        <TabsContent value="tokens" className="mt-0">
          <ProjectAccessTokens />
        </TabsContent>
        <TabsContent value="services" className="mt-0">
          <ServicesSettings projectId={projectId} client={client} />
        </TabsContent>
        <TabsContent value="settings" className="mt-0">
          <ProjectSettings project={project} projectId={projectId} client={client} />
        </TabsContent>
      </div>
    </Tabs>
  );
};
