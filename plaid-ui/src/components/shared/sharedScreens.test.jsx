// The chrome the three apps share, mounted.
//
// Each of these screens was written out once per app until they were moved in
// here, and each is read by every app there is, so a mistake in one is a
// mistake everywhere. This asks each of them for one thing it puts on the
// page, with the descriptor an app hands the package (the vitest setup file
// names one, as `main.jsx` does).
//
// What a screen's body does is the body's own test: the guideline editor, the
// activity feed, the comments browser and the assistant each have one, and
// they stand in here so that what is under test is the chrome around them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all, texts } from '../../test/renderComponent.jsx';

const { auth, editor } = vi.hoisted(() => ({ auth: {}, editor: {} }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor }));
vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('../../domain/layerCounts.js', () => ({ wordCountsByProject: async () => ({}) }));
vi.mock('../../hooks/useProjectRoster.js', () => ({ useProjectRoster: () => [] }));

// The bodies, each tested where it lives.
vi.mock('../assistant/AssistantChrome.jsx', () => ({
  AssistantChrome: ({ children, className }) => (
    <div className={className}>{children({ chip: null })}</div>
  ),
}));
vi.mock('../guidelines/GuidelinesTab.jsx', () => ({
  GuidelinesTab: ({ canWrite }) => <p>{canWrite ? 'guidelines, writable' : 'guidelines'}</p>,
}));
vi.mock('../assistant/AssistantTab.jsx', () => ({
  AssistantTab: ({ projectName }) => <p>asking about {projectName}</p>,
}));
vi.mock('./ActivityPanel.jsx', () => ({
  ActivityPanel: ({ documentHref }) => <p>activity: {documentHref({ id: 'd1' })}</p>,
}));
vi.mock('./CommentsBrowser.jsx', () => ({
  CommentsBrowser: ({ emptyText, jumpHref }) => (
    <p>
      {emptyText} {jumpHref('s1')}
    </p>
  ),
}));

const { AppShell } = await import('./AppShell.jsx');
const { DocumentTabStrip } = await import('./DocumentTabStrip.jsx');
const { ProjectTabStrip } = await import('./ProjectTabStrip.jsx');
const { ProjectListPage } = await import('./ProjectListPage.jsx');
const { NewProjectDialog } = await import('./NewProjectDialog.jsx');
const { ProjectSettingsShell } = await import('./ProjectSettingsShell.jsx');
const { ProjectGuidelinesPage } = await import('./ProjectGuidelinesPage.jsx');
const { ProjectAssistantPage } = await import('./ProjectAssistantPage.jsx');
const { ProjectActivityPage } = await import('./ProjectActivityPage.jsx');
const { DocumentCommentsPage } = await import('./DocumentCommentsPage.jsx');

const PROJECT = { id: 'p1', name: 'Ay', maintainers: ['u'], writers: [], readers: [] };
const USER = { id: 'u', displayName: 'You', isAdmin: true };

const client = {
  projects: {
    get: vi.fn(async () => PROJECT),
    list: vi.fn(async () => [{ id: 'p1', name: 'Ay', documentCount: 2 }]),
  },
  users: { avatarUrl: () => null },
};

// The app's own tab strip, which every project-level screen is handed.
const Strip = ({ project }) => <p>strip: {project?.name ?? 'loading'}</p>;

let view = null;
const mount = async (element, path = '/projects/p1') => {
  view = await renderComponent(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>);
  return view;
};

// A screen that reads the project out of the path needs a route to read it
// from, as it has in the app.
const mountAt = (pattern, element, path) =>
  mount(
    <Routes>
      <Route path={pattern} element={element} />
    </Routes>,
    path,
  );

const text = () => view.container.textContent;

beforeEach(() => {
  auth.user = USER;
  auth.logout = vi.fn();
  auth.getClient = () => client;
  editor.projectId = 'p1';
  editor.documentId = 'd1';
  editor.project = PROJECT;
  editor.doc = {
    id: 'd1',
    name: 'One',
    dataVersion: 1,
    subscribe: () => () => {},
    getSnapshot: () => 0,
  };
  editor.comments = null;
  editor.canComment = true;
  editor.canDeleteAnyComment = false;
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

describe('the shared chrome', () => {
  it('AppShell names the app and puts the screen inside it', async () => {
    await mount(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/projects/:projectId" element={<p>the screen</p>} />
        </Route>
      </Routes>,
    );
    expect(text()).toContain('Plaid IGT');
    expect(text()).toContain('the screen');
    // An admin is offered the server's admin area, which is one app's.
    expect(all(view.container, 'header a').some((a) => a.textContent === 'Admin')).toBe(true);
  });

  it('DocumentTabStrip draws the breadcrumb and every tab as a link', async () => {
    await mount(
      <DocumentTabStrip
        projectId="p1"
        project={PROJECT}
        document={{ name: 'One' }}
        tabs={[
          { value: 'edit', label: 'Text', to: '/projects/p1/documents/d1/edit' },
          { value: 'details', label: 'Details', to: '/projects/p1/documents/d1/details' },
        ]}
      />,
      '/projects/p1/documents/d1/details',
    );
    expect(text()).toContain('Ay');
    expect(text()).toContain('One');
    expect(texts(view.container, '[role="tab"]')).toEqual(['Text', 'Details']);
    // The tab standing on this path is the one that is on.
    const active = all(view.container, '[role="tab"]').find(
      (t) => t.getAttribute('data-state') === 'active',
    );
    expect(active.textContent).toBe('Details');
  });

  it('ProjectTabStrip draws the project it is on and the tabs it was given', async () => {
    await mount(
      <ProjectTabStrip
        projectId="p1"
        project={PROJECT}
        tabs={[
          { value: 'documents', label: 'Documents', to: '/projects/p1/documents' },
          { value: 'guidelines', label: 'Guidelines', to: '/projects/p1/guidelines' },
        ]}
      />,
    );
    expect(text()).toContain('Ay');
    expect(texts(view.container, '[role="tab"]')).toEqual(['Documents', 'Guidelines']);
  });

  it('ProjectListPage lists the projects and offers a new one in the app’s words', async () => {
    await mount(
      <ProjectListPage wordLayerId={() => null} newProject="New IGT project" form={() => null} />,
      '/projects',
    );
    expect(text()).toContain('Ay');
    expect(text()).toContain('New IGT project');
  });

  it('NewProjectDialog names what it makes and what the app will build', async () => {
    await mount(
      <NewProjectDialog
        isOpen
        onClose={() => {}}
        onSuccess={() => {}}
        title="New IGT project"
        create={async () => ({ id: 'p2' })}
      >
        <p>a text layer and a sentence layer</p>
      </NewProjectDialog>,
    );
    // The dialog is a portal, so it is on the body rather than in the container.
    expect(document.body.textContent).toContain('New IGT project');
    expect(document.body.textContent).toContain('a text layer and a sentence layer');
  });

  it('ProjectSettingsShell lists its sections and renders the one on the path', async () => {
    await mount(
      <Routes>
        <Route
          path="/projects/:projectId/:section"
          element={
            <ProjectSettingsShell
              tabs={Strip}
              href={(p, s) => `/projects/${p}/${s}`}
              sections={[
                { value: 'general', label: 'General', body: () => <p>the general section</p> },
                { value: 'services', label: 'Services', body: () => <p>the services</p> },
              ]}
            />
          }
        />
      </Routes>,
      '/projects/p1/services',
    );
    expect(texts(view.container, 'nav a')).toEqual(['General', 'Services']);
    expect(text()).toContain('the services');
    expect(text()).not.toContain('the general section');
  });

  it('ProjectGuidelinesPage waits for the project, then hands the tab what it may do', async () => {
    await mountAt(
      '/projects/:projectId/guidelines',
      <ProjectGuidelinesPage tabs={Strip} />,
      '/projects/p1/guidelines',
    );
    expect(text()).toContain('strip: Ay');
    expect(text()).toContain('guidelines, writable');
  });

  it('ProjectAssistantPage names the project it is asking about', async () => {
    await mountAt(
      '/projects/:projectId/assistant',
      <ProjectAssistantPage tabs={Strip} adapter={{}} />,
      '/projects/p1/assistant',
    );
    expect(text()).toContain('asking about Ay');
  });

  it('ProjectActivityPage opens a document where this app keeps it', async () => {
    await mountAt(
      '/projects/:projectId/activity',
      <ProjectActivityPage tabs={Strip} />,
      '/projects/p1/activity',
    );
    // The panel is for maintainers, so it waits on the project before it draws.
    await view.step(async () => {});
    expect(text()).toContain('activity: /projects/p1/documents/d1');
  });

  it('DocumentCommentsPage jumps to a sentence where this app keeps it', async () => {
    await mountAt(
      '/projects/:projectId/documents/:documentId/comments',
      <DocumentCommentsPage buildAnchors={() => []} />,
      '/projects/p1/documents/d1/comments',
    );
    expect(text()).toContain('No comments on this document yet');
    expect(text()).toContain('/projects/p1/documents/d1?tab=analyze&focusSentence=s1');
  });
});
