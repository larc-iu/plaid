// M2-5: the Delete project confirm names the vocabularies that stay, and says
// no other project uses them only where the app can know it (an admin, who
// lists every project).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

const { auth } = vi.hoisted(() => ({ auth: { user: { id: 'me@x.org', isAdmin: false } } }));
vi.mock('@ui/contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { GeneralSettings } = await import('./GeneralSettings.jsx');

const KUKAMA = { id: 'v1', name: 'Kukama' };
const LOANS = { id: 'v2', name: 'Loans' };
const ELSEWHERE = { id: 'v3', name: 'Shared' };

let view;
afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

const open = async ({ vocabs, others = [], isAdmin = false }) => {
  auth.user = { id: 'me@x.org', isAdmin };
  const project = { id: 'p1', name: 'Pear Stories', vocabs, config: {} };
  const list = vi.fn(async () => [project, ...others]);
  const client = { projects: { list } };
  auth.getClient = () => client;
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
  await view.step(() => {});
  const box = document.body.querySelector('[role=alertdialog]');
  return {
    text: box.textContent.replace(/\s+/g, ' '),
    card: view.container.textContent,
    list,
  };
};

describe('the Delete project confirm', () => {
  it('names the vocabularies that stay, and that no other project uses them, to an admin', async () => {
    const { text, card } = await open({ vocabs: [KUKAMA, LOANS], isAdmin: true });
    expect(card).not.toContain('under Vocabularies');
    expect(text).toContain(
      'The vocabularies Kukama and Loans stay under Vocabularies with all their entries. No other project uses them.',
    );
  });

  it('says it only of the ones no other project uses', async () => {
    const { text } = await open({
      vocabs: [KUKAMA, ELSEWHERE],
      others: [{ id: 'p2', name: 'Other', vocabs: [ELSEWHERE] }],
      isAdmin: true,
    });
    expect(text).toContain(
      'The vocabularies Kukama and Shared stay under Vocabularies with all their entries. No other project uses Kukama.',
    );
  });

  it('claims nothing of other projects to someone who cannot list them all', async () => {
    const { text, list } = await open({ vocabs: [KUKAMA] });
    expect(text).toContain('The vocabulary Kukama stays under Vocabularies with all its entries.');
    expect(text).not.toContain('No other project');
    expect(list).not.toHaveBeenCalled();
  });

  it('is as before for a project with no vocabulary', async () => {
    const { text } = await open({ vocabs: [], isAdmin: true });
    expect(text).not.toContain('Vocabularies');
    expect(text).toContain('This cannot be undone.');
  });
});
