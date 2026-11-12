import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';

// The setup wizard links the vocabularies ticked here once the project is
// made, and core refuses the link from anyone who holds no role in the
// project the vocabulary belongs to. So the wizard marks those rows the way
// Project settings does, rather than offering a tick that fails at the end of
// setup.

vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));

let auth;
vi.mock('@/contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

import { VocabularyStep } from './VocabularyStep.jsx';

// "Field notes" is a project the user reads. Theirs belongs to one the user
// holds no role in, which only an admin's project list carries.
const FIELD_NOTES = { id: 'pa', name: 'Field notes', readers: ['me@x.org'] };
const CLOSED = { id: 'pb', name: 'Closed', maintainers: ['other@x.org'] };
const client = {
  vocabLayers: {
    list: vi.fn(async () => [
      { id: 'v1', name: 'Mine', project: 'pa' },
      { id: 'v2', name: 'Theirs', project: 'pb' },
      {
        id: 'v3',
        name: 'Half',
        project: 'pa',
        config: { igt: { import: { projectId: 'p9' } } },
      },
    ]),
  },
  projects: {
    list: vi.fn(async () => (auth.user.isAdmin ? [FIELD_NOTES, CLOSED] : [FIELD_NOTES])),
  },
};

const rowOf = (root, name) => byText(root, 'tbody tr', name);
const boxOf = (root, name) => rowOf(root, name).querySelector('input[type=checkbox]');

const mount = (onDataChange = () => {}) =>
  renderComponent(
    <MemoryRouter>
      <VocabularyStep data={{}} onDataChange={onDataChange} client={client} />
    </MemoryRouter>,
  );

beforeEach(() => {
  auth = { user: { id: 'me@x.org', isAdmin: false } };
});

describe('the setup wizard, Vocabularies', () => {
  it('will not tick a vocabulary of a project the user holds no role in', async () => {
    const onDataChange = vi.fn();
    const view = await mount(onDataChange);
    expect(boxOf(view.container, 'Mine').disabled).toBe(false);
    expect(boxOf(view.container, 'Theirs').disabled).toBe(true);
    expect(rowOf(view.container, 'Theirs').textContent).toContain(
      'Needs access to the project it belongs to.',
    );
    expect(rowOf(view.container, 'Theirs').textContent).toContain('From another project.');
    expect(rowOf(view.container, 'Mine').textContent).toContain('From “Field notes”.');
    await view.step(() => rowOf(view.container, 'Theirs').click());
    expect(onDataChange).not.toHaveBeenCalled();
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const sent = onDataChange.mock.calls[0][0].vocabularies;
    expect(sent.filter((v) => v.enabled).map((v) => v.id)).toEqual(['v1']);
    await view.unmount();
  });

  // R58: a vocabulary an unfinished import made is linked into no project.
  it('will not tick a vocabulary an unfinished import made, and says why', async () => {
    const view = await mount();
    expect(boxOf(view.container, 'Half').disabled).toBe(true);
    expect(rowOf(view.container, 'Half').textContent).toContain('Import did not finish.');
    await view.unmount();
  });

  it('lets an admin tick any vocabulary', async () => {
    auth = { user: { id: 'admin@x.org', isAdmin: true } };
    const view = await mount();
    expect(boxOf(view.container, 'Theirs').disabled).toBe(false);
    await view.unmount();
  });

  // A writer or maintainer of a vocabulary's own project changes its
  // entries from any project that links it (0b73a7993), so the step says
  // who changes it, not that it is read only here.
  it('says what a vocabulary is, and who changes one of another project', async () => {
    const view = await mount();
    expect(view.container.textContent).toContain(
      'A vocabulary is a lexicon. Words and morphemes link to its entries, so one entry is ' +
        'glossed the same way everywhere. A vocabulary that belongs to another project is changed ' +
        'by the writers and maintainers of that project.',
    );
    expect(view.container.textContent).not.toContain('shared lexicon');
    expect(view.container.textContent).not.toContain('read only here');
    await view.unmount();
  });

  // A project set up again (an existing one) holds its own vocabularies.
  it('shows the vocabularies of a project set up again ticked and locked', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <VocabularyStep
          data={{}}
          onDataChange={() => {}}
          client={client}
          projectId="pa"
          isNewProject={false}
        />
      </MemoryRouter>,
    );
    expect(boxOf(view.container, 'Mine').checked).toBe(true);
    expect(boxOf(view.container, 'Mine').disabled).toBe(true);
    expect(rowOf(view.container, 'Mine').textContent).toContain('Belongs to this project.');
    expect(boxOf(view.container, 'Theirs').checked).toBe(false);
    await view.unmount();
  });
});
