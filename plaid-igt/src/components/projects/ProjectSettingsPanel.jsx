import { ProjectSettingsLayout } from '@ui/components/shared/ProjectSettingsLayout.jsx';
import { ProjectAccessSettings } from '@ui/components/shared/ProjectAccessSettings.jsx';
import { ServicesSettings } from './settings/ServicesSettings';
import { GeneralSettings } from './settings/GeneralSettings.jsx';
import { OrthographyVocabSettings } from './settings/OrthographyVocabSettings.jsx';
import { AnnotationSettings } from './settings/AnnotationSettings.jsx';
import { ROLE_OPTIONS } from '@/domain/roleGrants.js';

// What the project is, then what it annotates with, then who may touch it: the
// order every app lists its settings in. Access holds the members and the API
// tokens, two answers to one question.
const SECTIONS = [
  {
    value: 'general',
    label: 'General',
    body: ({ project, projectId, client, onProjectUpdate }) => (
      <GeneralSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />
    ),
  },
  {
    value: 'text-and-vocab',
    label: 'Text and vocab',
    body: ({ project, projectId, client, onProjectUpdate }) => (
      <OrthographyVocabSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />
    ),
  },
  {
    value: 'annotation',
    label: 'Annotation',
    body: ({ project, projectId, client, onProjectUpdate }) => (
      <AnnotationSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />
    ),
  },
  {
    value: 'access',
    label: 'Access',
    body: ({ onProjectUpdate }) => (
      <ProjectAccessSettings
        roleOptions={ROLE_OPTIONS}
        profileHref="/profile"
        onProjectUpdate={onProjectUpdate}
      />
    ),
  },
  {
    value: 'services',
    label: 'Services',
    body: ({ projectId, client }) => <ServicesSettings projectId={projectId} client={client} />,
  },
];

// The Settings tab's body: project administration in the shared settings
// layout, the same one plaid-ud and plaid-umr draw. Route-backed by the caller:
// the active section follows /general, /text-and-vocab, /annotation, /access,
// /services, so deep links and the browser back button keep working, and each
// section in the list is a link to its path.
export const ProjectSettingsPanel = ({ project, projectId, client, section, onProjectUpdate }) => (
  <ProjectSettingsLayout
    sections={SECTIONS}
    active={SECTIONS.find((s) => s.value === section) ?? SECTIONS[0]}
    href={(value) => `/projects/${projectId}/${value}`}
    bodyProps={{ project, projectId, client, onProjectUpdate }}
  />
);
