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
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
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
const { chrome } = vi.hoisted(() => ({ chrome: {} }));
vi.mock('../assistant/AssistantChrome.jsx', () => ({
  AssistantChrome: ({ children, className, assistantRoute }) => {
    chrome.assistantRoute = assistantRoute;
    return <div className={className}>{children({ chip: null })}</div>;
  },
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
// The account menu is a dropdown of its own; what the shell is asked about
// here is what happens when Sign out is chosen.
vi.mock('./UserButton', () => ({
  UserButton: ({ onLogout }) => (
    <button type="button" onClick={() => onLogout()}>
      Sign out
    </button>
  ),
}));

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('./ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { AppShell } = await import('./AppShell.jsx');
const { useUnsavedDraft } = await import('../../hooks/useUnsavedDraft.js');
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

// A screen under the shell with something typed on it and not saved.
const Typing = () => {
  useUnsavedDraft('The name you have typed');
  return <p>the screen</p>;
};

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
  confirm.mockReset();
  confirm.mockResolvedValue(false);
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

  // Signing out takes the screen underneath with it, so it is a way out like
  // any other. The shell asks before it goes.
  it('AppShell asks before signing out with something typed on the screen', async () => {
    await mount(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/projects/:projectId" element={<Typing />} />
        </Route>
      </Routes>,
    );
    const signOut = all(view.container, 'button').find((b) => b.textContent === 'Sign out');

    await view.step(() => signOut.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'The name you have typed is not saved. Leaving loses it.',
      }),
    );
    // Refused: still signed in, still on the screen.
    expect(auth.logout).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await view.step(() => signOut.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(auth.logout).toHaveBeenCalled();
  });

  const shellAt = (props, path = '/projects/p1') =>
    mount(
      <Routes>
        <Route element={<AppShell {...props} />}>
          <Route path="*" element={<p>the screen</p>} />
        </Route>
      </Routes>,
      path,
    );
  const links = () =>
    all(view.container, 'header a').map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      current: a.className.includes('bg-accent '),
    }));

  // One header in every app: the app's own destinations and its guide on the
  // left, Admin with the account on the right.
  it('AppShell draws the app’s nav, its guide, and Admin as a route of its own', async () => {
    await shellAt(
      {
        nav: [
          { to: '/projects', label: 'Projects', match: (p) => p.startsWith('/projects') },
          { to: '/vocabularies', label: 'Vocabularies', match: (p) => p.startsWith('/voc') },
        ],
        guideHref: 'https://example.org/igt-guide.html',
        adminTo: '/admin',
      },
      '/vocabularies/v1',
    );
    const drawn = links();
    const navLinks = all(view.container, 'header nav a').map((a) => a.textContent);
    expect(navLinks).toEqual(['Projects', 'Vocabularies', 'Guide']);
    expect(drawn.find((l) => l.text === 'Guide')).toMatchObject({
      href: 'https://example.org/igt-guide.html',
      target: '_blank',
    });
    expect(drawn.find((l) => l.text === 'Vocabularies').current).toBe(true);
    expect(drawn.find((l) => l.text === 'Projects').current).toBe(false);
    expect(drawn.find((l) => l.text === 'Admin').href).toBe('/admin');
    // The header stays on screen down a long page, in every app.
    expect(view.container.querySelector('header').className).toContain('sticky');
  });

  it('AppShell with no nav of its own still links its guide, and Admin leaves for igt', async () => {
    await shellAt({ guideHref: 'https://example.org/ud-guide.html' });
    const navLinks = all(view.container, 'header nav a').map((a) => a.textContent);
    expect(navLinks).toEqual(['Guide']);
    // Another app's admin area is another document: a full page load.
    expect(links().find((l) => l.text === 'Admin').href).toMatch(/#\/admin$/);
  });

  it('AppShell asks the app whether its assistant has the screen, when the path cannot say', async () => {
    await shellAt(
      { isAssistantRoute: ({ search }) => new URLSearchParams(search).get('tab') === 'assistant' },
      '/projects/p1?tab=assistant',
    );
    expect(chrome.assistantRoute).toBe(true);
    await view.unmount();
    await shellAt({}, '/projects/p1?tab=assistant');
    expect(chrome.assistantRoute).toBe(false);
  });

  it('ProjectTabStrip names the project in a heading of its own direction', async () => {
    await mount(
      <ProjectTabStrip
        projectId="p1"
        project={{ ...PROJECT, name: 'مشروع' }}
        tabs={[{ value: 'documents', label: 'Documents', to: '/projects/p1/documents' }]}
      />,
    );
    const h1 = view.container.querySelector('h1');
    expect(h1.textContent).toBe('مشروع');
    expect(h1.getAttribute('dir')).toBe('auto');
    // The current page closes the trail, dark and not a link.
    expect(view.container.querySelector('[aria-current="page"]').tagName).toBe('SPAN');
  });

  it('ProjectTabStrip takes the active tab from an app that keeps it off the path', async () => {
    await mount(
      <ProjectTabStrip
        projectId="p1"
        project={PROJECT}
        active="search"
        tabs={[
          { value: 'documents', label: 'Documents', to: '/projects/p1' },
          { value: 'search', label: 'Search', to: '/projects/p1?tab=search' },
        ]}
      />,
      '/projects/p1',
    );
    const active = all(view.container, '[role="tab"]').find(
      (t) => t.getAttribute('data-state') === 'active',
    );
    expect(active.textContent).toBe('Search');
    expect(active.getAttribute('href')).toBe('/projects/p1?tab=search');
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

  it('ProjectTabStrip leaves out a tab whose showing is not known yet', async () => {
    // `null` from useAssistantAvailable means the answer has not come back.
    // Drawing the tab meanwhile offers an assistant that may not exist.
    await mount(
      <ProjectTabStrip
        projectId="p1"
        project={PROJECT}
        tabs={[
          { value: 'documents', label: 'Documents', to: '/projects/p1/documents' },
          { value: 'assistant', label: 'Assistant', to: '/projects/p1/assistant', show: null },
          { value: 'activity', label: 'Activity', to: '/projects/p1/activity', show: true },
        ]}
      />,
    );
    expect(texts(view.container, '[role="tab"]')).toEqual(['Documents', 'Activity']);
  });

  it('ProjectTabStrip asks before a tab leaves something typed on the screen', async () => {
    const Loc = () => <p data-testid="at">{useLocation().pathname}</p>;
    await mount(
      <>
        <ProjectTabStrip
          projectId="p1"
          project={PROJECT}
          tabs={[
            { value: 'documents', label: 'Documents', to: '/projects/p1/documents' },
            { value: 'guidelines', label: 'Guidelines', to: '/projects/p1/guidelines' },
          ]}
        />
        <Typing />
        <Loc />
      </>,
      '/projects/p1/guidelines',
    );
    const documents = all(view.container, '[role="tab"]').find(
      (t) => t.textContent === 'Documents',
    );
    await view.step(() => documents.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'The name you have typed is not saved. Leaving loses it.',
      }),
    );
    expect(view.container.querySelector('[data-testid="at"]').textContent).toBe(
      '/projects/p1/guidelines',
    );
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
    // The project's own heading is the tab strip's. The page adds none.
    expect(view.container.querySelector('h1')).toBe(null);
  });

  // A section folded into another keeps its old address working.
  it('ProjectSettingsShell sends a folded section’s old path to the section that holds it', async () => {
    const Loc = () => <p data-testid="at">{useLocation().pathname}</p>;
    await mount(
      <>
        <Routes>
          <Route
            path="/projects/:projectId/:section"
            element={
              <ProjectSettingsShell
                tabs={Strip}
                href={(p, s) => `/projects/${p}/${s}`}
                sections={[
                  { value: 'general', label: 'General', body: () => <p>general</p> },
                  {
                    value: 'management',
                    label: 'Access',
                    aliases: ['tokens'],
                    body: () => <p>members and tokens</p>,
                  },
                ]}
              />
            }
          />
        </Routes>
        <Loc />
      </>,
      '/projects/p1/tokens',
    );
    expect(view.container.querySelector('[data-testid="at"]').textContent).toBe(
      '/projects/p1/management',
    );
    expect(text()).toContain('members and tokens');
  });

  // Walking from one project to the next keeps the shell mounted. Until the
  // new project answers, a section is handed nothing rather than the old one,
  // whose layer ids a Save would otherwise write under the new project.
  it('ProjectSettingsShell never hands a section the project the reader left', async () => {
    const seen = [];
    let go;
    const Nav = () => {
      go = useNavigate();
      return null;
    };
    let answerB;
    const saved = client.projects.get;
    client.projects.get = vi.fn((id) =>
      id === 'p1'
        ? Promise.resolve(PROJECT)
        : new Promise((resolve) => {
            answerB = () => resolve({ ...PROJECT, id: 'p2', name: 'Bee' });
          }),
    );
    try {
      await mount(
        <>
          <Nav />
          <Routes>
            <Route
              path="/projects/:projectId/:section"
              element={
                <ProjectSettingsShell
                  tabs={Strip}
                  href={(p, s) => `/projects/${p}/${s}`}
                  sections={[
                    {
                      value: 'general',
                      label: 'General',
                      body: ({ projectId, project }) => {
                        seen.push([projectId, project?.id ?? null]);
                        return <p>general</p>;
                      },
                    },
                  ]}
                />
              }
            />
          </Routes>
        </>,
        '/projects/p1/general',
      );
      await view.step(async () => {});
      expect(seen.at(-1)).toEqual(['p1', 'p1']);

      await view.step(() => go('/projects/p2/general'));
      expect(seen.filter(([at, of]) => of && at !== of)).toEqual([]);
      expect(text()).toContain('strip: loading');

      await view.step(async () => answerB());
      expect(seen.at(-1)).toEqual(['p2', 'p2']);
    } finally {
      client.projects.get = saved;
    }
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
