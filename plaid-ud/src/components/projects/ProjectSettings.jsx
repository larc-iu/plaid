import { ProjectSettingsShell } from '@ui/components/shared/ProjectSettingsShell.jsx';
import { ProjectAccessTokens } from '@ui/components/shared/ProjectAccessTokens.jsx';
import { ProjectCustomization } from './ProjectCustomization.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectGeneral } from './ProjectGeneral.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// This app's settings sections, in order, for the shared shell
// (@ui/components/shared/ProjectSettingsShell): user and permission
// management, UD customization (vocab and colors), services (registry and
// defaults), API access tokens, and general project settings (name, tokenizer
// locale, delete).
//
// The UD layer-structure setup form (ProjectConfiguration) is NOT here: it is a
// standalone page at `/configuration`, which the document list's missing-layers
// button leads to.
const SECTIONS = [
  { value: 'management', label: 'Users & Permissions', body: () => <ProjectManagement /> },
  { value: 'customization', label: 'UD Customization', body: () => <ProjectCustomization /> },
  { value: 'services', label: 'Services', body: () => <ProjectServicesSettings /> },
  {
    value: 'tokens',
    label: 'Access Tokens',
    body: () => <ProjectAccessTokens profileHref="/profile" />,
  },
  {
    value: 'general',
    label: 'General',
    body: ({ reload }) => <ProjectGeneral onProjectUpdate={reload} />,
  },
];

export const ProjectSettings = () => (
  <ProjectSettingsShell
    tabs={ProjectTabs}
    sections={SECTIONS}
    href={(projectId, section) => `/projects/${projectId}/${section}`}
  />
);
