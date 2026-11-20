import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

vi.mock('@ui/components/shared/ConfirmProvider', () => ({
  useConfirm: () => async () => true,
}));

const { projectTarget, documentTarget } = await import('./projectLinks');
const { AdminVocabularies } = await import('./AdminVocabularies');
const { AdminInvites } = await import('./AdminInvites');
const { AdminServices } = await import('./AdminServices');
const { AdminActivity } = await import('./AdminActivity');
const { UserDetail } = await import('./UserDetail');

// Every project link in the admin area leads where the Projects tab's name
// does: a project this app owns opens here, a UD or UMR project opens in its
// own app. This app's project route is its setup wizard, so a UD project
// linked here would be set up as IGT.

const UD_HREF = /\/#\/projects\/p-ud\/documents$/;

const udProject = {
  id: 'p-ud',
  name: 'Treebank',
  config: {},
  readers: ['u@x.com'],
  writers: [],
  maintainers: [],
  vocabs: [{ id: 'v1' }],
  textLayers: [
    {
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          config: { plaid: { role: 'syntactic-word' } },
          spanLayers: [{ config: { ud: { upos: true } } }],
        },
      ],
    },
  ],
};

const igtProject = {
  id: 'p-igt',
  name: 'Glossed',
  config: { igt: { initialized: true } },
  readers: ['u@x.com'],
  writers: [],
  maintainers: [],
  textLayers: [],
};

const entry = (project, document) => ({
  id: `e-${project.id}`,
  time: '2026-11-01T00:00:00Z',
  user: { id: 'u@x.com' },
  projects: [{ id: project.id, name: project.name }],
  documents: document ? [document] : [],
  ops: [{ description: 'x' }],
  opCount: 1,
});

const FEED = [
  entry(udProject, { id: 'd-ud', name: 'Sentences' }),
  entry(igtProject, { id: 'd-igt', name: 'Story' }),
  entry({ ...udProject, id: 'p-ud' }),
];

const client = () => ({
  projects: { list: vi.fn(async () => [udProject, igtProject]) },
  vocabLayers: { list: vi.fn(async () => [{ id: 'v1', name: 'Lexicon', project: 'p-ud' }]) },
  invites: {
    list: vi.fn(async () => [
      { code: 'c1', kind: 'invite', status: 'open', projectId: 'p-ud', projectRole: 'reader' },
    ]),
  },
  messages: {
    discoverServices: vi.fn(async (pid) =>
      pid === 'p-ud'
        ? [{ serviceId: 'parser', serviceName: 'Parser', online: true, lastSeenAt: null }]
        : [],
    ),
  },
  users: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: 'u@x.com', displayName: 'U' })),
    avatarUrl: () => null,
    auditPage: vi.fn(async () => ({ entries: FEED, nextCursor: null })),
  },
  apiTokens: { list: vi.fn(async () => []) },
  audit: {
    tally: vi.fn(async () => []),
    listPage: vi.fn(async () => ({ entries: FEED, nextCursor: null })),
  },
});

const render = async (element) => {
  localStorage.clear();
  const view = await renderComponent(<MemoryRouter>{element}</MemoryRouter>);
  await view.step(async () => {});
  return view;
};

const hrefOf = (root, text) => byText(root, 'a', text)?.getAttribute('href');

describe('where a project link leads', () => {
  it('leads to this app for its own project and to the owning app for another', () => {
    expect(projectTarget(igtProject)).toBe('/projects/p-igt');
    expect(projectTarget(udProject).href).toMatch(UD_HREF);
    expect(documentTarget({ id: 'd' }, igtProject)).toBe('/projects/p-igt/documents/d');
    // Another app's document leads to that app's project.
    expect(documentTarget({ id: 'd' }, udProject).href).toMatch(UD_HREF);
  });

  it('Vocabularies', async () => {
    const view = await render(<AdminVocabularies client={client()} />);
    const links = all(view.container, 'tbody a').filter((a) => a.textContent === 'Treebank');
    expect(links).toHaveLength(2);
    links.forEach((a) => expect(a.getAttribute('href')).toMatch(UD_HREF));
    await view.unmount();
  });

  it('Invites', async () => {
    const view = await render(<AdminInvites client={client()} />);
    expect(hrefOf(view.container, 'Treebank')).toMatch(UD_HREF);
    await view.unmount();
  });

  it("the Services tab's expanded row", async () => {
    const view = await render(<AdminServices client={client()} currentUser={{ id: 'a@x.com' }} />);
    await view.step(async () => all(view.container, 'button[aria-label="Expand"]')[0].click());
    expect(hrefOf(view.container, 'Treebank')).toMatch(UD_HREF);
    await view.unmount();
  });

  it("the user page's projects and feed", async () => {
    const view = await render(
      <UserDetail client={client()} userId="u@x.com" backTo="/admin" onEdit={() => {}} />,
    );
    const anchors = all(view.container, 'a').filter((a) => a.textContent === 'Treebank');
    expect(anchors.length).toBe(2);
    anchors.forEach((a) => expect(a.getAttribute('href')).toMatch(UD_HREF));
    expect(hrefOf(view.container, 'Sentences')).toMatch(UD_HREF);
    expect(hrefOf(view.container, 'Story')).toBe('/projects/p-igt/documents/d-igt');
    expect(hrefOf(view.container, 'Glossed')).toBe('/projects/p-igt');
    await view.unmount();
  });

  it("the Activity feed's project and document links", async () => {
    const view = await render(<AdminActivity client={client()} />);
    expect(hrefOf(view.container, 'Sentences')).toMatch(UD_HREF);
    expect(hrefOf(view.container, 'Treebank')).toMatch(UD_HREF);
    expect(hrefOf(view.container, 'Story')).toBe('/projects/p-igt/documents/d-igt');
    await view.unmount();
  });
});
