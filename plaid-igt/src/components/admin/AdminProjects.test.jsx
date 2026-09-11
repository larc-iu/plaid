import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';
import { AdminProjects } from './AdminProjects';

// The Shape column is the only place on the server that says which app owns a
// project, and getting it wrong sends an admin to the wrong app: which, for a
// project this one did not set up, means its setup wizard, pointed at somebody
// else's corpus. So: what each shape reads off, and that a UD project's name
// leaves this app rather than linking inside it.

const client = (projects) => ({
  projects: { list: vi.fn(async () => projects) },
});

const udProject = (over = {}) => ({
  id: 'p-ud',
  name: 'Treebank',
  config: {},
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
  ...over,
});

const render = async (projects) => {
  const view = await renderComponent(
    <MemoryRouter>
      <AdminProjects client={client(projects)} currentUser={{ id: 'a@b.com' }} />
    </MemoryRouter>,
  );
  // The list arrives from an async effect, so let that promise land.
  await view.step(async () => {});
  return view;
};

describe('AdminProjects', () => {
  it('labels a UD project UD, and an IGT one IGT', async () => {
    const view = await render([
      udProject(),
      { id: 'p-igt', name: 'Glossed', config: { igt: { initialized: true } }, textLayers: [] },
    ]);
    const shapes = texts(view.container, 'tbody tr td:nth-child(2)');
    expect(shapes).toContain('UD');
    expect(shapes).toContain('IGT');
  });

  it('does not call a project UD on its syntactic-word role alone', async () => {
    // plaid-igt tags a morpheme layer and can carry syntactic-word too. Only
    // the `ud` namespace on the span layers is UD's, and this is the case that
    // used to read as "Other app" and would read as UD if the role were enough.
    const view = await render([
      udProject({
        textLayers: [
          {
            config: { plaid: { role: 'baseline' } },
            tokenLayers: [
              {
                config: { plaid: { role: 'syntactic-word' } },
                spanLayers: [{ config: { igt: { gloss: true } } }],
              },
            ],
          },
        ],
      }),
    ]);
    expect(texts(view.container, 'tbody tr td:nth-child(2)')).toEqual(['Other app']);
  });

  it("sends a UD project's name to the UD app, not into this one", async () => {
    const view = await render([udProject()]);
    const link = view.container.querySelector('tbody tr a');
    // A full page load: the other app is a different document with its own
    // bundle and its own hash router.
    expect(link.getAttribute('href')).toMatch(/\/#\/projects\/p-ud\/documents$/);
    expect(link.getAttribute('href')).not.toMatch(/^\/projects/);
  });
});
