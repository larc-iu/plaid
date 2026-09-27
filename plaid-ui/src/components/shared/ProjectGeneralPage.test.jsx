// A project's General settings, one page for every app. Every Save on it is the
// default button and stays disabled until its own section differs from what is
// stored (the Language Save used to be enabled with nothing changed).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { configureUi } from '../../lib/uiConfig.js';

const { auth, notify } = vi.hoisted(() => ({
  auth: {},
  notify: { notifySuccess: vi.fn(), notifyError: vi.fn() },
}));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../lib/notify.js', () => notify);

const { ProjectGeneralPage } = await import('./ProjectGeneralPage.jsx');

const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const saves = (root) => all(root, 'button').filter((b) => b.textContent.trim() === 'Save');
const cards = (root) => all(root, '.rounded-xl').map((c) => c.querySelector('div').textContent);

let client;
let view;
const project = (language) => ({
  id: 'p1',
  name: 'Texts',
  config: language ? { ud: { language } } : {},
});
const mount = async (props = {}) => {
  view = await renderComponent(
    <MemoryRouter>
      <ProjectGeneralPage project={project('en')} onSaved={vi.fn()} {...props} />
    </MemoryRouter>,
  );
  return view;
};

beforeEach(() => {
  client = {
    projects: {
      update: vi.fn(async () => {}),
      setConfig: vi.fn(async () => {}),
      deleteConfig: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  };
  auth.getClient = () => client;
  notify.notifySuccess.mockClear();
  notify.notifyError.mockClear();
  configureUi({ ...RESTORE, configNamespace: 'ud', appRoutes: { projects: '/projects' } });
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  configureUi(RESTORE);
});

describe('ProjectGeneralPage', () => {
  it('draws Name, Language, the app sections and Delete, in that order', async () => {
    await mount({
      language: { description: 'The language.' },
      children: (
        <div className="rounded-xl">
          <div>Tokenizer locale</div>
        </div>
      ),
    });
    expect(cards(view.container)).toEqual(['Name', 'Language', 'Tokenizer locale', 'Delete']);
  });

  it('leaves out Language when the app keeps none', async () => {
    await mount();
    expect(cards(view.container)).toEqual(['Name', 'Delete']);
  });

  it('enables the name Save only for a changed, non-empty name', async () => {
    const onSaved = vi.fn();
    await mount({ onSaved });
    const [save] = saves(view.container);
    const field = view.container.querySelector('#project-name');
    expect(save.disabled).toBe(true);
    await view.step(() => typeInto(field, '   '));
    expect(save.disabled).toBe(true);
    expect(view.container.textContent).toContain('Project name cannot be empty');
    await view.step(() => typeInto(field, 'Texts '));
    expect(save.disabled).toBe(true);
    await view.step(() => typeInto(field, 'Lezgian texts'));
    expect(save.disabled).toBe(false);
    expect(save.className).toContain('bg-primary');
    await view.step(() => save.click());
    expect(client.projects.update).toHaveBeenCalledWith('p1', 'Lezgian texts');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('enables the language Save only once the tag differs, and writes the app namespace', async () => {
    const onSaved = vi.fn();
    await mount({ onSaved, language: { description: 'The language.' } });
    const save = saves(view.container)[1];
    const field = view.container.querySelector('[aria-label="Project language"]');
    expect(field.value).toBe('en');
    expect(save.disabled).toBe(true);
    await view.step(() => typeInto(field, ' en '));
    expect(save.disabled).toBe(true);
    await view.step(() => typeInto(field, 'de'));
    expect(save.disabled).toBe(false);
    await view.step(() => save.click());
    expect(client.projects.setConfig).toHaveBeenCalledWith('p1', 'ud', 'language', 'de');
    expect(onSaved).toHaveBeenCalledTimes(1);
    await view.step(() => typeInto(field, ''));
    await view.step(() => save.click());
    expect(client.projects.deleteConfig).toHaveBeenCalledWith('p1', 'ud', 'language');
  });

  it('says what the saved tag does, not the typed one', async () => {
    await mount({
      language: { description: 'The language.', note: (tag) => `Saved: ${tag || 'none'}` },
    });
    const field = view.container.querySelector('[aria-label="Project language"]');
    await view.step(() => typeInto(field, 'de'));
    expect(view.container.textContent).toContain('Saved: en');
  });
});
