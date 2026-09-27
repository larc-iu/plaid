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
let view;
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
  remove = vi.fn(async () => {});
  auth.getClient = () => ({ projects: { delete: remove } });
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
    expect(remove).not.toHaveBeenCalled();
  });

  it('submits on Enter in the name field, then lands on the project list', async () => {
    await mount();
    const box = await openConfirm();
    const field = box.querySelector('#delete-project-confirm');
    await view.step(() => enter(field));
    expect(remove).not.toHaveBeenCalled();
    await view.step(() => typeInto(field, 'Lezgian Texts'));
    await view.step(() => enter(field));
    expect(remove).toHaveBeenCalledWith('p1');
    expect(notify.notifySuccess).toHaveBeenCalledWith('Deleted “Lezgian Texts”');
    expect(view.container.textContent).toContain('the project list');
  });

  it('stays on the page and says so when the delete is refused', async () => {
    remove = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    });
    await mount();
    const box = await openConfirm();
    const field = box.querySelector('#delete-project-confirm');
    await view.step(() => typeInto(field, 'Lezgian Texts'));
    await view.step(() => button(box, 'Delete project').click());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(notify.notifyError).toHaveBeenCalledTimes(1);
    expect(notify.notifyError.mock.calls[0][1]).toBe('Failed to delete project');
    expect(button(view.container, 'Delete project')).toBeTruthy();
    expect(view.container.textContent).not.toContain('the project list');
  });
});
