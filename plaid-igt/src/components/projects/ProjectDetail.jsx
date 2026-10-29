import { useEffect, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { NewDocument } from './NewDocument';
import { ProjectSearch } from './search/ProjectSearch.jsx';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { Suspended } from '@ui/components/shared/Suspended';
import { ProjectTabPage } from '@ui/components/shared/ProjectTabPage.jsx';
import { ProjectTabStrip } from '@ui/components/shared/ProjectTabStrip.jsx';
import { ProjectDocumentsList } from '@ui/components/shared/ProjectDocumentsList.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { SectionHeader } from '@ui/components/shared/SectionHeader.jsx';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { lazyNamed } from '@ui/lib/lazyNamed';
import {
  readIgnoredTokens,
  readInitialized,
  readImportState,
  wordValueSpec,
} from '@/domain/igtConfig';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { isReviewed } from '@larc-iu/plaid-client';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { useTabParam } from '@ui/hooks/useTabParam.js';
import { contentTabsFor, isMaintainerTab, TAB_ALIASES } from '@/domain/projectTabs';
import { notifyNotAMaintainer } from '@ui/hooks/useManagedProject.js';
import { useComposeProject } from '@/hooks/useCompose';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { IGT_ASSISTANT } from './assistant/adapter.js';
import { UnfinishedImport } from './UnfinishedImport.jsx';

// The tabs a visit rarely opens ride in their own chunks: Bulk Edit,
// Validation, Activity, the Assistant (and its markdown), and Export (and the
// format writers). Documents, Search, and Settings load with the page.
const ProjectBulkEdit = lazyNamed(() => import('./bulk/ProjectBulkEdit.jsx'), 'ProjectBulkEdit');
const ProjectValidation = lazyNamed(
  () => import('./validate/ProjectValidation.jsx'),
  'ProjectValidation',
);
const ProjectAssistant = lazyNamed(
  () => import('./assistant/ProjectAssistant.jsx'),
  'ProjectAssistant',
);
const ProjectActivity = lazyNamed(() => import('./ProjectActivity.jsx'), 'ProjectActivity');
const GuidelinesTab = lazyNamed(
  () => import('@ui/components/guidelines/GuidelinesTab.jsx'),
  'GuidelinesTab',
);
const ProjectExport = lazyNamed(() => import('./ProjectExport.jsx'), 'ProjectExport');

// The settings sections live behind these path suffixes; keeping them in the
// URL means deep links and the back button still land on the right section.
// Title-bar labels for them, as ProjectSettingsPanel names them.
const SECTION_TITLES = {
  general: 'General',
  'text-and-vocab': 'Text and vocab',
  annotation: 'Annotation',
  access: 'Access',
  services: 'Services',
};

// The project screen: plaid-ui's project page (ProjectTabPage), which reads the
// project and its documents once for every tab here, under the shared tab
// strip. The content tabs (the document list, a Search tab, and for
// maintainers Bulk Edit, Validation and Activity) ride in `?tab=`. Export and
// Settings are path-backed: Settings renders project administration in the
// shared settings layout (ProjectSettingsPanel), one section per path suffix,
// and a preset's editor is a page of its own at /projects/:id/export/:presetId.
export const ProjectDetail = () => {
  const { projectId } = useParams();
  const { section, onExport } = usePlace(projectId);
  // "<Section> · <Project> · Plaid IGT" on a settings section, else
  // "<Project> · Plaid IGT".
  return (
    <ProjectTabPage
      title={onExport ? 'Export' : section ? SECTION_TITLES[section] : null}
      tabs={ProjectTabs}
      withDocuments
    >
      {(page) => <ProjectBody {...page} />}
    </ProjectTabPage>
  );
};

// Where on the project screen the path is: a settings section, Export, or
// neither (a content tab, in `?tab=`). A section may carry a sub-path, as
// /export/:presetId opens one preset's editor in place.
const usePlace = (projectId) => {
  const { pathname } = useLocation();
  const section =
    Object.keys(SECTION_TITLES).find((s) => pathname.startsWith(`/projects/${projectId}/${s}`)) ??
    null;
  return { section, onExport: pathname.startsWith(`/projects/${projectId}/export`) };
};

// The open tab, for the strip and the body alike.
const useProjectTab = (projectId, project) => {
  const { user } = useAuth();
  const { section, onExport } = usePlace(projectId);
  const canManage = canManageProject(project, user);
  // `ready` while the project is still loading would correct a good link:
  // `canManage` answers false until it lands, so the list can still grow.
  const contentTabs = useMemo(() => contentTabsFor(canManage), [canManage]);
  const [contentTab, , tabHref] = useTabParam(contentTabs, 'documents', {
    aliases: TAB_ALIASES,
    ready: !!project,
  });
  const active = onExport ? 'export' : section && canManage ? 'settings' : contentTab;
  return { active, section, tabHref, canManage };
};

// This app's project tabs, as data for the shared strip.
const ProjectTabs = ({ projectId, project }) => {
  const { client } = useAuth();
  const { active, tabHref, canManage } = useProjectTab(projectId, project);
  const assistantAvailable = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  const at = `/projects/${projectId}`;
  const tabs = [
    { value: 'documents', label: 'Documents', to: tabHref(at, 'documents') },
    { value: 'search', label: 'Search', to: tabHref(at, 'search') },
    { value: 'guidelines', label: 'Guidelines', to: tabHref(at, 'guidelines') },
    // Offered only when an assistant is online. The tab itself still renders
    // when it is the active one, so a link to a past conversation opens
    // whether or not one is running: this hides the invitation, not the
    // conversations.
    {
      value: 'assistant',
      label: 'Assistant',
      to: tabHref(at, 'assistant'),
      show: assistantAvailable,
      alsoWhenActive: true,
    },
    { value: 'bulk', label: 'Bulk Edit', to: tabHref(at, 'bulk'), show: canManage },
    { value: 'validate', label: 'Validation', to: tabHref(at, 'validate'), show: canManage },
    { value: 'activity', label: 'Activity', to: tabHref(at, 'activity'), show: canManage },
    { value: 'export', label: 'Export', to: `${at}/export` },
    // Entered at its first section. The path drives the panel.
    { value: 'settings', label: 'Settings', to: `${at}/general`, show: canManage },
  ];
  return <ProjectTabStrip projectId={projectId} project={project} tabs={tabs} active={active} />;
};

const ProjectBody = ({ project, projectId, client, documents, reload }) => {
  const { presetId = null } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { active, section, canManage } = useProjectTab(projectId, project);
  // Creating/editing documents needs WRITE, which writers have but managing
  // (settings/access) does not. Gate document-create on this so a reader isn't
  // shown a button that 403s on submit.
  const canWrite = canEditProject(project, user);
  // A code bound under Settings applies everywhere this project is open.
  useComposeProject(project);
  // A settings page reads the project again after each save and waits for that
  // read before it lets the next save go. Only the project, quietly: the
  // screen stays as it is meanwhile.
  const refreshProject = () => reload({ quiet: true });

  // A non-maintainer who lands on a settings URL has nothing to manage; bounce
  // them back to the document view rather than show an empty Settings panel.
  // A maintainers-only `?tab=` falls back to Documents (useTabParam). Either
  // way the reader is told why, as the shared guard (useManagedProject) does.
  const tabParam = new URLSearchParams(location.search).get('tab');
  useEffect(() => {
    if (canManage) return;
    if (section) {
      notifyNotAMaintainer();
      navigate(`/projects/${projectId}`, { replace: true });
    } else if (isMaintainerTab(tabParam)) {
      notifyNotAMaintainer();
    }
  }, [section, tabParam, canManage, projectId, navigate]);

  // A project not yet set up for IGT: maintainers go to the setup/adopt wizard;
  // non-maintainers can't create layers, so they get an informational notice
  // (rendered below) rather than a dead-end redirect into a wizard they can't
  // complete.
  // An import that never reported finishing: the project is half filled and
  // does not open. It is only deleted.
  const unfinishedImport = !!readImportState(project.config);
  const initialized = readInitialized(project.config);
  useEffect(() => {
    if (!initialized && !unfinishedImport && canManage) {
      navigate(`/projects/${projectId}/setup`, { replace: true });
    }
  }, [initialized, unfinishedImport, projectId, navigate, canManage]);

  // The New document control beside the list's heading. One component for as
  // long as what it is given stays the same, so its dialog survives a render.
  const NewDocumentHere = useMemo(
    () =>
      function NewDocumentHere(props) {
        return <NewDocument {...props} client={client} canManage={canManage} />;
      },
    [client, canManage],
  );

  // A project with nothing to open yet says why, in place of every tab's body.
  const notice = (children) => (
    <Notice role="status" icon={null} className={FORM_PAGE_WIDTH}>
      {children}
    </Notice>
  );

  if (unfinishedImport) {
    return notice(
      <UnfinishedImport
        client={client}
        project={project}
        canManage={canManage}
        onDeleted={() => navigate('/projects', { replace: true })}
      />,
    );
  }

  if (!initialized && !canManage) {
    return notice(<>This project is not set up for IGT. A project maintainer can set it up.</>);
  }

  // Only the active tab's body is mounted, as the tab widget's own panels did.
  let body = null;
  if (active === 'documents') {
    body = (
      <ProjectDocumentsList
        projectId={projectId}
        documents={documents}
        client={client}
        canEdit={canWrite}
        newDocument={NewDocumentHere}
        wordLayerId={getIgtLayerInfo(project).primaryTokenLayer?.id}
        wordValue={wordValueSpec(
          readIgnoredTokens(getIgtLayerInfo(project).primaryTokenLayer?.config),
        )}
        href={(documentId) => `/projects/${projectId}/documents/${documentId}`}
      />
    );
  } else if (active === 'search') {
    body = (
      <>
        <SectionHeader title="Search" />
        <ProjectSearch project={project} projectId={projectId} client={client} />
      </>
    );
  } else if (active === 'bulk' && canManage) {
    body = (
      <>
        <SectionHeader title="Bulk Edit" />
        <ProjectBulkEdit project={project} projectId={projectId} client={client} />
      </>
    );
  } else if (active === 'validate' && canManage) {
    // The same width as plaid-ud's and plaid-umr's Validation.
    body = (
      <div className={FORM_PAGE_WIDTH}>
        <ProjectValidation
          project={project}
          projectId={projectId}
          client={client}
          onProjectUpdate={refreshProject}
        />
      </div>
    );
  } else if (active === 'activity' && canManage) {
    body = (
      <>
        <SectionHeader title="Activity" />
        <ProjectActivity client={client} project={project} projectId={projectId} />
      </>
    );
  } else if (active === 'assistant') {
    body = (
      <ProjectAssistant
        projectId={projectId}
        projectName={project.name}
        client={client}
        userId={user?.id}
        canWrite={canWrite}
        contributor={!!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin })}
      />
    );
  } else if (active === 'guidelines') {
    body = (
      <>
        <SectionHeader title="Guidelines" />
        <GuidelinesTab
          client={client}
          projectId={projectId}
          project={project}
          canWrite={canWrite}
        />
      </>
    );
  } else if (active === 'export') {
    // A form, so the narrower width, from the page's left edge.
    body = (
      <div className={FORM_PAGE_WIDTH}>
        <ProjectExport
          project={project}
          projectId={projectId}
          client={client}
          documents={documents}
          canManage={canManage}
          presetId={presetId}
          onProjectUpdate={refreshProject}
        />
      </div>
    );
  } else if (active === 'settings' && canManage) {
    body = (
      <>
        <SectionHeader title="Settings" />
        <ProjectSettingsPanel
          project={project}
          projectId={projectId}
          client={client}
          section={section || 'general'}
          onProjectUpdate={refreshProject}
        />
      </>
    );
  }

  return <Suspended>{body}</Suspended>;
};
