import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The Language card writes `ud.language` on the project, against the value it
// read, and removes the cell when the field is cleared.

const managed = vi.hoisted(() => ({ current: null }));
const client = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useManagedProject.js', () => ({ useManagedProject: () => managed.current }));
vi.mock('@ui/contexts/useAuth.js', () => ({
  useAuth: () => ({ getClient: () => client.current }),
}));
const notify = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@ui/lib/notify.js', async (orig) => ({ ...(await orig()), ...notify }));
// A text layer for the tokenizer locale's card.
vi.mock('../../utils/udLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUdLayerInfo: () => ({ textLayer: { id: 't1', config: {} } }),
}));

const { ProjectGeneral } = await import('./ProjectGeneral.jsx');

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
      <ProjectGeneral />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  client.current = {
    projects: { setConfig: vi.fn(async () => {}), deleteConfig: vi.fn(async () => {}) },
    textLayers: { setConfig: vi.fn(async () => {}), deleteConfig: vi.fn(async () => {}) },
  };
  managed.current = {
    project: { id: 'p1', name: 'P', config: { ud: { language: 'en' } } },
    loading: false,
    fetchProject: vi.fn(async () => {}),
    canConfigure: true,
  };
});

describe('UD General, Language', () => {
  it('sets ud.language against the stored tag', async () => {
    const view = await mount();
    const field = view.container.querySelector('[aria-label="Project language"]');
    await view.step(() => typeInto(field, ' de '));
    await view.step(() => languageSave(view.container).click());
    expect(client.current.projects.setConfig).toHaveBeenCalledTimes(1);
    expect(client.current.projects.setConfig).toHaveBeenCalledWith(
      'p1',
      'ud',
      'language',
      'de',
      undefined,
      { expected: 'en' },
    );
    expect(client.current.projects.deleteConfig).not.toHaveBeenCalled();
    expect(managed.current.fetchProject).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('deletes ud.language when the field is cleared', async () => {
    const view = await mount();
    const field = view.container.querySelector('[aria-label="Project language"]');
    await view.step(() => typeInto(field, ''));
    await view.step(() => languageSave(view.container).click());
    expect(client.current.projects.deleteConfig).toHaveBeenCalledTimes(1);
    expect(client.current.projects.deleteConfig).toHaveBeenCalledWith(
      'p1',
      'ud',
      'language',
      undefined,
      { expected: 'en' },
    );
    expect(client.current.projects.setConfig).not.toHaveBeenCalled();
    await view.unmount();
  });
});

// H3-7-4: `en_US` was saved without a word, and Tokenize then did nothing.
// Both fields ask for a BCP-47 tag and refuse one that is not.
describe('UD General, a tag that is not BCP-47', () => {
  for (const [label, bundle, title] of [
    ['Project language', 'projects', null],
    ['Tokenizer locale', 'textLayers', 'Tokenizer locale not saved'],
  ]) {
    it(`is refused by ${label}, and says so`, async () => {
      const view = await mount();
      const field = view.container.querySelector(`[aria-label="${label}"]`);
      await view.step(() => typeInto(field, 'en_US'));
      await view.step(() => field.closest('form').querySelector('button').click());
      expect(client.current[bundle].setConfig).not.toHaveBeenCalled();
      const call = notify.notifyError.mock.calls[0];
      expect(call[0]).toBe('"en_US" is not a BCP-47 language tag.');
      if (title) expect(call[1]).toBe(title);
      await view.unmount();
    });
  }
});
