import { Users, Plug, Settings, Rows3, SpellCheck } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AccessManagement } from './AccessManagement';
import { ProjectAccessTokens } from './ProjectAccessTokens';
import { ServicesSettings } from './settings/ServicesSettings';
import { GeneralSettings } from './settings/GeneralSettings.jsx';
import { OrthographyVocabSettings } from './settings/OrthographyVocabSettings.jsx';
import { AnnotationSettings } from './settings/AnnotationSettings.jsx';

// What the project is, then what it annotates with, then who may touch it.
const SECTIONS = [
  { value: 'general', label: 'General', icon: Settings },
  { value: 'text-and-vocab', label: 'Text and Vocab', icon: SpellCheck },
  { value: 'annotation', label: 'Annotation', icon: Rows3 },
  { value: 'access', label: 'Access', icon: Users },
  { value: 'services', label: 'Services', icon: Plug },
];

// The Settings tab's body: project administration as a vertical, left-side tab
// group (Radix Tabs in vertical orientation). Route-backed by the caller — the
// active section follows /general, /text-and-vocab, /annotation, /access,
// /services —
// so deep links and the browser back button keep working.
export const ProjectSettingsPanel = ({
  project,
  projectId,
  client,
  user,
  section,
  onSectionChange,
  onProjectUpdate,
}) => {
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
              to={`/projects/${projectId}/${s.value}`}
              className="w-full justify-start gap-2 rounded-md border-b-0 px-3 py-2 data-[state=active]:bg-muted data-[state=active]:text-foreground"
            >
              <Icon className="h-4 w-4 shrink-0" /> {s.label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="min-w-0 flex-1">
        {/* Who may touch the project, and the tokens they touch it with: two
            answers to one question, so one section. */}
        <TabsContent value="access" className="mt-0">
          <div className="flex flex-col gap-8 [&>*+*]:border-t [&>*+*]:pt-8">
            <AccessManagement
              project={project}
              user={user}
              projectId={projectId}
              client={client}
              onDataUpdate={onProjectUpdate}
            />
            <ProjectAccessTokens />
          </div>
        </TabsContent>
        <TabsContent value="services" className="mt-0">
          <ServicesSettings projectId={projectId} client={client} />
        </TabsContent>
        <TabsContent value="general" className="mt-0">
          <GeneralSettings
            project={project}
            projectId={projectId}
            client={client}
            onProjectUpdate={onProjectUpdate}
          />
        </TabsContent>
        <TabsContent value="text-and-vocab" className="mt-0">
          <OrthographyVocabSettings
            project={project}
            projectId={projectId}
            client={client}
            onProjectUpdate={onProjectUpdate}
          />
        </TabsContent>
        <TabsContent value="annotation" className="mt-0">
          <AnnotationSettings
            project={project}
            projectId={projectId}
            client={client}
            onProjectUpdate={onProjectUpdate}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
};
