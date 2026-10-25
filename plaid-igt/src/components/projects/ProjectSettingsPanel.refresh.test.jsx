import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

// The settings sections are one page over one project. A save in one section
// reads the page's project again, so the next section opened shows it: a
// vocabulary linked under Text and vocab offers its entry fields as Lexicon
// field choices under Annotation, with no reload.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));
vi.mock('@/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'me@x.org', isAdmin: false } }),
}));

// Radix's Select does not open under jsdom: drawn as a native select with the
// same value and onValueChange.
vi.mock('@ui/components/ui/select', () => {
  const Select = ({ value, onValueChange, children }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  );
  return {
    Select,
    SelectContent: ({ children }) => children,
    SelectItem: ({ value, children }) => <option value={value}>{children}</option>,
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

const { ProjectSettingsPanel } = await import('./ProjectSettingsPanel.jsx');

const role = (r, extra = {}) => ({ plaid: { role: r }, ...extra });
const VOCABS = {
  v1: { id: 'v1', name: 'Lexicon', maintainers: ['me@x.org'], config: { igt: { fields: {} } } },
  v2: {
    id: 'v2',
    name: 'Botany',
    maintainers: ['me@x.org'],
    config: { igt: { fields: { habitat: {} } } },
  },
};

const fakeClient = () => {
  const linked = ['v1'];
  const project = () => ({
    id: 'p1',
    name: 'P',
    config: {},
    vocabs: linked.map((id) => VOCABS[id]),
    textLayers: [
      {
        id: 'text',
        config: role('baseline'),
        tokenLayers: [
          { id: 'sent', config: role('sentence'), spanLayers: [] },
          {
            id: 'word',
            config: role('word', { igt: { orthographies: [] } }),
            spanLayers: [],
          },
          {
            id: 'morph',
            config: role('morpheme'),
            spanLayers: [{ id: 'gloss', name: 'Gloss', config: { igt: { scope: 'Morpheme' } } }],
          },
        ],
      },
    ],
  });
  return {
    projects: {
      get: vi.fn(async () => project()),
      linkVocab: vi.fn(async (pid, id) => {
        linked.push(id);
      }),
      unlinkVocab: vi.fn(async () => {}),
    },
    vocabLayers: { list: vi.fn(async () => Object.values(VOCABS)) },
    tokenLayers: { setConfig: vi.fn(async () => {}) },
    spanLayers: { setConfig: vi.fn(async () => {}) },
    batched: async () => [],
    query: vi.fn(async () => ({ results: [] })),
  };
};

// The page: it holds the project, and onProjectUpdate reads it again.
const Page = ({ client, initial, section }) => {
  const [project, setProject] = useState(initial);
  const reload = async () => {
    const fresh = await client.projects.get('p1');
    setProject(fresh);
    return fresh;
  };
  return (
    <MemoryRouter>
      <ProjectSettingsPanel
        project={project}
        projectId="p1"
        client={client}
        section={section}
        onProjectUpdate={reload}
      />
    </MemoryRouter>
  );
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const glossChoices = () => {
  const row = all(document.body, 'tbody tr').find(
    (tr) => tr.querySelector('td:nth-child(2)')?.textContent.trim() === 'Gloss',
  );
  return [...row.querySelector('select').options].map((o) => o.textContent);
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Project settings, one project for every section', () => {
  it('offers a vocabulary linked under Text and vocab as Lexicon field choices under Annotation', async () => {
    const client = fakeClient();
    const initial = await client.projects.get('p1');
    const view = await renderComponent(
      <Page client={client} initial={initial} section="text-and-vocab" />,
    );
    await view.step(settle);
    const botany = byText(view.container, 'tbody tr', 'Botany');
    await view.step(async () => {
      botany.click();
      await settle();
    });
    expect(client.projects.linkVocab).toHaveBeenCalledWith('p1', 'v2');
    await view.rerender(<Page client={client} initial={initial} section="annotation" />);
    await view.step(settle);
    expect(glossChoices()).toContain('Habitat');
    await view.unmount();
  });
});
