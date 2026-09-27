import { ProjectSettingsShell } from '@ui/components/shared/ProjectSettingsShell.jsx';
import { ProjectAccessSettings } from '@ui/components/shared/ProjectAccessSettings.jsx';
import { ProjectGeneralSettings } from './ProjectGeneralSettings.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { UmrSettings } from './UmrSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { ROLE_OPTIONS } from '../../domain/roleGrants.js';

// This app's settings sections, in order, for the shared shell
// (@ui/components/shared/ProjectSettingsShell): general project settings (name,
// language, text direction, delete), the UMR settings, who may touch the
// project and the API tokens they touch it with, and the service each
// integration spot uses. The same order as every app: what the project is,
// what it annotates with, who may touch it.
//
// Access keeps the `management` path it had as Users & Permissions, and the
// old Access Tokens path lands on it.
//
// The layer setup form (ProjectConfiguration) is NOT here: it is a standalone
// page at `/configuration`, which the document list's missing-layers button
// leads to.
const SECTIONS = [
  {
    value: 'general',
    label: 'General',
    body: ({ reload }) => <ProjectGeneralSettings onProjectUpdate={reload} />,
  },
  { value: 'customization', label: 'UMR settings', body: () => <UmrSettings /> },
  {
    value: 'management',
    label: 'Access',
    aliases: ['tokens'],
    body: ({ reload }) => (
      <ProjectAccessSettings
        roleOptions={ROLE_OPTIONS}
        profileHref="/profile"
        onProjectUpdate={reload}
      />
    ),
  },
  { value: 'services', label: 'Services', body: () => <ProjectServicesSettings /> },
];

export const ProjectSettings = () => (
  <ProjectSettingsShell
    tabs={ProjectTabs}
    sections={SECTIONS}
    href={(projectId, section) => `/projects/${projectId}/${section}`}
  />
);
