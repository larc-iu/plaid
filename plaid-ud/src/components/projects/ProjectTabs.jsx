import { useAuth } from '../../contexts/AuthContext.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { ProjectTabStrip } from '@ui/components/shared/ProjectTabStrip.jsx';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { UD_ASSISTANT } from '../assistant/adapter.js';

// This app's project-level tabs, as data for the shared strip
// (@ui/components/shared/ProjectTabStrip), which draws them, decides which is
// active, and publishes the project to the assistant panel.
//
// `project` is the full object every page already fetches (it carries the layer
// config `getUdLayerInfo` reads); it may be null mid-load, which the gating
// below tolerates.

// Settings stands for every section route under it, and for the standalone
// layer-setup page.
const SETTINGS = /\/(management|customization|services|tokens|general|configuration)$/;

export const ProjectTabs = ({ projectId, project }) => {
  const { user, getClient } = useAuth();
  // The tab is offered only when an assistant is online. The ROUTE still
  // works, so a link to a past conversation opens whether or not one is
  // running: this hides the invitation, not the conversations.
  const assistantAvailable = useAssistantAvailable(getClient(), projectId, UD_ASSISTANT.app);
  const canManage = canManageProject(project, user);
  // Settings assumes a configured project; an unconfigured one routes to the
  // standalone layer-setup page instead.
  const configured = getUdLayerInfo(project).isConfigured;

  const at = (section) => `/projects/${projectId}/${section}`;
  const tabs = [
    { value: 'documents', label: 'Documents', to: at('documents') },
    { value: 'search', label: 'Search', to: at('search') },
    { value: 'guidelines', label: 'Guidelines', to: at('guidelines') },
    {
      value: 'assistant',
      label: 'Assistant',
      to: at('assistant'),
      show: assistantAvailable,
      alsoWhenActive: true,
    },
    { value: 'validate', label: 'Validation', to: at('validate'), show: canManage },
    { value: 'activity', label: 'Activity', to: at('activity'), show: canManage },
    {
      value: 'settings',
      label: 'Project Settings',
      to: at(configured ? 'management' : 'configuration'),
      match: SETTINGS,
      show: canManage,
    },
    { value: 'import-export', label: 'Import & Export', to: at('import-export') },
  ];

  return <ProjectTabStrip projectId={projectId} project={project} tabs={tabs} />;
};
