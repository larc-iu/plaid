// Deleting a project, the same card in all three apps: an outline red button at
// rest, a confirm that wants the name typed, solid red only on that confirm's
// own button, and Enter in the name field submitting it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { configureUi } from '../../lib/uiConfig.js';

const { auth, notify } = vi.hoisted(() => ({
  auth: {},
  notify: { notifySuccess: vi.fn(), notifyError: vi.fn() },
}));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../lib/notify.js', () => notify);

const { DeleteProjectCard } = await import('./DeleteProjectCard.jsx');

const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };
const ROUTES = { projects: '/projects' };

const button = (root, text) => all(root, 'button').find((b) => b.textContent.trim() === text);
const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const enter = (el) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

let remove;
let preview;
let view;
// The real delete, as opposed to the dry run the confirm asks on open.
const deletes = () => remove.mock.calls.filter(([, , opts]) => !opts?.dryRun);
const mount = async () => {
  view = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/general']}>
      <Routes>
        <Route
          path="/projects/:p/general"
          element={<DeleteProjectCard project={{ id: 'p1', name: 'Lezgian Texts' }} />}
        />
        <Route path="/projects" element={<p>the project list</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return view;
};
const openConfirm = async () => {
  await view.step(() => button(view.container, 'Delete project').click());
  return document.body.querySelector('[role=alertdialog]');
};

beforeEach(() => {
  preview = async () => ({ vocabularies: [] });
  remove = vi.fn(async (_id, _message, opts) => (opts?.dryRun ? preview() : undefined));
  const client = { projects: { delete: (...args) => remove(...args) } };
  auth.client = client;
  auth.getClient = () => client;
  notify.notifySuccess.mockClear();
  notify.notifyError.mockClear();
  configureUi({ ...RESTORE, appRoutes: ROUTES });
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  configureUi(RESTORE);
});

describe('DeleteProjectCard', () => {
  it('rests as an outline red button, never a solid one', async () => {
    await mount();
    const rest = button(view.container, 'Delete project');
    expect(rest.className).toContain('text-destructive');
    expect(rest.className).toContain('border');
    expect(rest.className).not.toContain('bg-destructive ');
    expect(rest.className.split(/\s+/)).not.toContain('bg-destructive');
  });

  it('confirms only once the name is typed, ignoring case, and the confirm is the solid one', async () => {
    await mount();
    const box = await openConfirm();
    const confirm = button(box, 'Delete project');
    expect(confirm.className.split(/\s+/)).toContain('bg-destructive');
    expect(confirm.disabled).toBe(true);
    const field = box.querySelector('#delete-project-confirm');
    await view.step(() => typeInto(field, 'lezgian'));
    expect(confirm.disabled).toBe(true);
    expect(box.textContent).toContain('The name does not match.');
    await view.step(() => typeInto(field, '  lezgian texts '));
    expect(confirm.disabled).toBe(false);
    expect(deletes()).toEqual([]);
  });

  it('submits on Enter in the name field, then lands on the project list', async () => {
    await mount();
    const box = await openConfirm();
    const field = box.querySelector('#delete-project-confirm');
    await view.step(() => enter(field));
    expect(deletes()).toEqual([]);
    await view.step(() => typeInto(field, 'Lezgian Texts'));
    await view.step(() => enter(field));
    expect(deletes()).toEqual([['p1']]);
    expect(notify.notifySuccess).toHaveBeenCalledWith('Deleted “Lezgian Texts”');
    expect(view.container.textContent).toContain('the project list');
  });

  it('stays on the page and says so when the delete is refused', async () => {
    remove.mockImplementation(async (_id, _message, opts) => {
      if (opts?.dryRun) return preview();
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    });
    await mount();
    const box = await openConfirm();
    const field = box.querySelector('#delete-project-confirm');
    await view.step(() => typeInto(field, 'Lezgian Texts'));
    await view.step(() => button(box, 'Delete project').click());
    expect(deletes()).toHaveLength(1);
    expect(notify.notifyError).toHaveBeenCalledTimes(1);
    expect(notify.notifyError.mock.calls[0][1]).toBe('Failed to delete project');
    expect(button(view.container, 'Delete project')).toBeTruthy();
    expect(view.container.textContent).not.toContain('the project list');
  });
});

// REV-FX-R57-2 S5: a name typed before Cancel stayed in the field, and the
// confirm opened again already armed.
describe('the confirm opened again after Cancel', () => {
  it('starts with an empty name and the delete disabled', async () => {
    await mount();
    let dialog = await openConfirm();
    const input = dialog.querySelector('#delete-project-confirm');
    await view.step(() => typeInto(input, 'Lezgian Texts'));
    await view.step(() => button(dialog, 'Cancel').click());
    dialog = await openConfirm();
    expect(dialog.querySelector('#delete-project-confirm').value).toBe('');
    expect(button(dialog, 'Delete project').disabled).toBe(true);
    expect(deletes()).toEqual([]);
  });
});

// A project's own vocabularies are deleted with it, and a project whose
// vocabulary another project uses cannot be deleted (vocabulary home, SPEC 5.3).
const refusedWith = (n) =>
  Object.assign(new Error('HTTP 409'), {
    status: 409,
    method: 'DELETE',
    responseData: {
      error: `${n} other ${n === 1 ? 'project uses' : 'projects use'} a vocabulary of this project.`,
      'other-projects': n,
    },
  });

describe('what the delete takes', () => {
  it('asks a dry run on open, and Delete waits for it with the name typed', async () => {
    let answer;
    preview = () => new Promise((resolve) => (answer = resolve));
    await mount();
    const box = await openConfirm();
    expect(remove).toHaveBeenCalledWith('p1', undefined, { dryRun: true });
    await view.step(() => typeInto(box.querySelector('#delete-project-confirm'), 'Lezgian Texts'));
    expect(button(box, 'Delete project').disabled).toBe(true);
    await view.step(() => answer({ vocabularies: [] }));
    expect(button(box, 'Delete project').disabled).toBe(false);
    expect(box.textContent).not.toContain('vocabular');
  });

  it('names the one vocabulary the project owns', async () => {
    preview = async () => ({ vocabularies: [{ id: 'v1', name: 'Lezgian Lexicon' }] });
    await mount();
    const box = await openConfirm();
    expect(box.textContent).toContain(
      'This cannot be undone. Its vocabulary “Lezgian Lexicon” is deleted with it.',
    );
  });

  it('names every vocabulary the project owns', async () => {
    preview = async () => ({
      vocabularies: [
        { id: 'v1', name: 'Lexicon' },
        { id: 'v2', name: 'Roots' },
        { id: 'v3', name: 'Affixes' },
      ],
    });
    await mount();
    const box = await openConfirm();
    expect(box.textContent).toContain(
      'Its vocabularies “Lexicon”, “Roots” and “Affixes” are deleted with it.',
    );
  });

  it('is refused while another project uses one of its vocabularies: no name to type, Cancel only', async () => {
    preview = async () => {
      throw refusedWith(1);
    };
    await mount();
    const box = await openConfirm();
    expect(box.textContent).toContain(
      '1 other project uses a vocabulary of this project. It can be deleted once that project unlinks it.',
    );
    expect(box.textContent).not.toContain('This cannot be undone.');
    expect(box.querySelector('#delete-project-confirm')).toBeNull();
    expect(button(box, 'Delete project')).toBeUndefined();
    expect(button(box, 'Cancel')).toBeTruthy();
    expect(deletes()).toEqual([]);
  });

  it('counts several such projects', async () => {
    preview = async () => {
      throw refusedWith(3);
    };
    await mount();
    const box = await openConfirm();
    expect(box.textContent).toContain(
      '3 other projects use a vocabulary of this project. It can be deleted once they unlink it.',
    );
  });

  it('shows the same refusal when another project borrowed one after the dry run', async () => {
    remove.mockImplementation(async (_id, _message, opts) => {
      if (opts?.dryRun) return { vocabularies: [{ id: 'v1', name: 'Lexicon' }] };
      throw refusedWith(2);
    });
    await mount();
    const box = await openConfirm();
    await view.step(() => typeInto(box.querySelector('#delete-project-confirm'), 'Lezgian Texts'));
    await view.step(() => button(box, 'Delete project').click());
    expect(deletes()).toHaveLength(1);
    expect(notify.notifyError).not.toHaveBeenCalled();
    const still = document.body.querySelector('[role=alertdialog]');
    expect(still.textContent).toContain(
      '2 other projects use a vocabulary of this project. It can be deleted once they unlink it.',
    );
    expect(view.container.textContent).not.toContain('the project list');
  });

  it('lets the delete go ahead when the dry run fails otherwise', async () => {
    preview = async () => {
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    const box = await openConfirm();
    await view.step(() => typeInto(box.querySelector('#delete-project-confirm'), 'Lezgian Texts'));
    expect(button(box, 'Delete project').disabled).toBe(false);
    quiet.mockRestore();
  });
});
