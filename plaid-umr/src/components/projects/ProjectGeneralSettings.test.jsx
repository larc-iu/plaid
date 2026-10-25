import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The Language card writes `umr.language` on the project, against the value it
// read, and removes the cell when the field is cleared.

const managed = vi.hoisted(() => ({ current: null }));
const client = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useManagedProject.js', () => ({ useManagedProject: () => managed.current }));
vi.mock('@ui/contexts/useAuth.js', () => ({
  useAuth: () => ({ getClient: () => client.current }),
}));

const { ProjectGeneralSettings } = await import('./ProjectGeneralSettings.jsx');

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const languageSave = (root) =>
  root.querySelector('[aria-label="Project language"]').closest('form').querySelector('button');

const mount = () =>
  renderComponent(
    <MemoryRouter>
      <ProjectGeneralSettings />
    </MemoryRouter>,
  );

beforeEach(() => {
  client.current = {
    projects: { setConfig: vi.fn(async () => {}), deleteConfig: vi.fn(async () => {}) },
  };
  managed.current = {
    project: { id: 'p1', name: 'P', config: { umr: { language: 'en' } } },
    loading: false,
    fetchProject: vi.fn(async () => {}),
    canConfigure: true,
  };
});

describe('UMR General, Language', () => {
  it('sets umr.language against the stored tag', async () => {
    const view = await mount();
    const field = view.container.querySelector('[aria-label="Project language"]');
    await view.step(() => typeInto(field, ' arp '));
    await view.step(() => languageSave(view.container).click());
    expect(client.current.projects.setConfig).toHaveBeenCalledTimes(1);
    expect(client.current.projects.setConfig).toHaveBeenCalledWith(
      'p1',
      'umr',
      'language',
      'arp',
      undefined,
      { expected: 'en' },
    );
    expect(client.current.projects.deleteConfig).not.toHaveBeenCalled();
    expect(managed.current.fetchProject).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('deletes umr.language when the field is cleared', async () => {
    const view = await mount();
    const field = view.container.querySelector('[aria-label="Project language"]');
    await view.step(() => typeInto(field, ''));
    await view.step(() => languageSave(view.container).click());
    expect(client.current.projects.deleteConfig).toHaveBeenCalledTimes(1);
    expect(client.current.projects.deleteConfig).toHaveBeenCalledWith(
      'p1',
      'umr',
      'language',
      undefined,
      { expected: 'en' },
    );
    expect(client.current.projects.setConfig).not.toHaveBeenCalled();
    await view.unmount();
  });
});
