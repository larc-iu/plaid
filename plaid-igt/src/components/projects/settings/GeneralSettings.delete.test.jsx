// The Delete project confirm in igt's General settings is plaid-ui's: it asks
// core what the delete takes and names the project's own vocabularies, which
// are deleted with it, or shows core's refusal while another project uses one.
// igt adds nothing to it (the note that the vocabularies stay is gone, since
// they do not). The client here is the real plaid-client-js over a stubbed
// fetch, so what opening the confirm SENDS is what is checked.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlaidClient } from '@larc-iu/plaid-client';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

const { auth } = vi.hoisted(() => ({ auth: { user: { id: 'me@x.org', isAdmin: false } } }));
vi.mock('@ui/contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { GeneralSettings } = await import('./GeneralSettings.jsx');

let view;
afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  vi.unstubAllGlobals();
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// `answer` gives core's answer to the dry run.
const open = async (answer) => {
  const sent = [];
  vi.stubGlobal('fetch', async (url, init = {}) => {
    sent.push(`${init.method ?? 'GET'} ${String(url).replace('http://plaid.test', '')}`);
    return answer();
  });
  const client = new PlaidClient('http://plaid.test', 'token');
  auth.client = client;
  auth.getClient = () => client;
  const project = {
    id: 'p1',
    name: 'Pear Stories',
    maintainers: ['me@x.org'],
    vocabs: [{ id: 'v1', name: 'Kukama', project: 'p1' }],
    config: {},
  };
  view = await renderComponent(
    <MemoryRouter>
      <GeneralSettings
        project={project}
        projectId="p1"
        client={client}
        onProjectUpdate={() => {}}
      />
    </MemoryRouter>,
  );
  const button = all(view.container, 'button').find(
    (b) => b.textContent.trim() === 'Delete project',
  );
  await view.step(() => button.click());
  for (let i = 0; i < 5; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
  const box = document.body.querySelector('[role=alertdialog]');
  return { text: box.textContent.replace(/\s+/g, ' '), sent };
};

describe('the Delete project confirm', () => {
  it('sends only the dry run, and names the vocabularies deleted with the project', async () => {
    const { text, sent } = await open(() =>
      json(200, {
        vocabularies: [
          { id: 'v1', name: 'Kukama' },
          { id: 'v2', name: 'Loans' },
        ],
      }),
    );
    expect(sent).toEqual(['DELETE /api/v1/projects/p1?dry-run=true']);
    expect(text).toContain('Its vocabularies “Kukama” and “Loans” are deleted with it.');
    expect(text).not.toContain('not deleted');
  });

  it('shows the refusal while another project uses one of its vocabularies', async () => {
    const { text, sent } = await open(() =>
      json(409, {
        error: '1 other project uses a vocabulary of this project.',
        'other-projects': 1,
      }),
    );
    expect(sent).toEqual(['DELETE /api/v1/projects/p1?dry-run=true']);
    expect(text).toContain(
      '1 other project uses a vocabulary of this project. It can be deleted once that project unlinks it.',
    );
    expect(text).not.toContain('not deleted');
  });
});
