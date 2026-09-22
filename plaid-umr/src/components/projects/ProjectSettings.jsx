import { ProjectSettingsShell } from '@ui/components/shared/ProjectSettingsShell.jsx';
import { ProjectAccessTokens } from '@ui/components/shared/ProjectAccessTokens.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectGeneralSettings } from './ProjectGeneralSettings.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { UmrSettings } from './UmrSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// This app's settings sections, in order, for the shared shell
// (@ui/components/shared/ProjectSettingsShell): user and permission
// management, the UMR settings, the service each integration spot uses, API
// access tokens, and general project settings (name, language, text direction,
// delete).
//
// The layer setup form (ProjectConfiguration) is NOT here: it is a standalone
// page at `/configuration`, which the document list's missing-layers button
// leads to.
const SECTIONS = [
  { value: 'management', label: 'Users & Permissions', body: () => <ProjectManagement /> },
  { value: 'customization', label: 'UMR settings', body: () => <UmrSettings /> },
  { value: 'services', label: 'Services', body: () => <ProjectServicesSettings /> },
  {
    value: 'tokens',
    label: 'Access Tokens',
    body: () => <ProjectAccessTokens profileHref="/profile" />,
  },
  {
    value: 'general',
    label: 'General',
    body: ({ reload }) => <ProjectGeneralSettings onProjectUpdate={reload} />,
  },
];

export const ProjectSettings = () => (
  <ProjectSettingsShell
    tabs={ProjectTabs}
    sections={SECTIONS}
    href={(projectId, section) => `/projects/${projectId}/${section}`}
  />
);
