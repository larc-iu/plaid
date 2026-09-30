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
const project = () => ({ id: 'p1', name: 'Texts' });
const mount = async (props = {}) => {
  view = await renderComponent(
    <MemoryRouter>
      <ProjectGeneralPage project={project()} onSaved={vi.fn()} {...props} />
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
  configureUi({ ...RESTORE, appRoutes: { projects: '/projects' } });
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  configureUi(RESTORE);
});

describe('ProjectGeneralPage', () => {
  it('draws Name, Language, the app sections and Delete, in that order', async () => {
    await mount({
      language: { saved: '', save: vi.fn(), description: 'The language.' },
      children: (
        <div className="rounded-xl">
          <div>Tokenizer locale</div>
        </div>
      ),
    });
    expect(cards(view.container)).toEqual([
      'Name',
      'Language',
      'Tokenizer locale',
      'Project plaid',
      'Delete',
    ]);
  });

  it('leaves out Language when the app keeps none', async () => {
    await mount();
    expect(cards(view.container)).toEqual(['Name', 'Project plaid', 'Delete']);
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

  it('keeps the name Save disabled at rest when the stored name has surrounding space', async () => {
    await mount({ project: { id: 'p1', name: ' Texts  ' } });
    const [save] = saves(view.container);
    const field = view.container.querySelector('#project-name');
    expect(field.value).toBe(' Texts  ');
    expect(save.disabled).toBe(true);
    await view.step(() => typeInto(field, 'Texts'));
    expect(save.disabled).toBe(true);
    await view.step(() => typeInto(field, 'Texts 2'));
    expect(save.disabled).toBe(false);
  });

  it('enables the language Save only once the tag differs, and hands the tag to the app', async () => {
    const onSaved = vi.fn();
    const save = vi.fn(async () => {});
    await mount({ onSaved, language: { saved: 'en', save, description: 'The language.' } });
    const button = saves(view.container)[1];
    const field = view.container.querySelector('[aria-label="Project language"]');
    expect(field.value).toBe('en');
    expect(button.disabled).toBe(true);
    await view.step(() => typeInto(field, ' en '));
    expect(button.disabled).toBe(true);
    await view.step(() => typeInto(field, ' de '));
    expect(button.disabled).toBe(false);
    await view.step(() => button.click());
    expect(save).toHaveBeenCalledWith('de');
    expect(onSaved).toHaveBeenCalledTimes(1);
    await view.step(() => typeInto(field, ''));
    await view.step(() => button.click());
    expect(save).toHaveBeenLastCalledWith('');
  });

  it('says what the saved tag does, not the typed one', async () => {
    await mount({
      language: {
        saved: 'en',
        save: vi.fn(),
        description: 'The language.',
        note: (tag) => `Saved: ${tag || 'none'}`,
      },
    });
    const field = view.container.querySelector('[aria-label="Project language"]');
    await view.step(() => typeInto(field, 'de'));
    expect(view.container.textContent).toContain('Saved: en');
  });

  describe('Project plaid', () => {
    const box = (root) =>
      all(root, 'label')
        .find((l) => l.textContent.includes("Show the project's plaid"))
        ?.querySelector('input[type="checkbox"]');

    it('is on when nothing is stored, and shows a stored off', async () => {
      await mount();
      expect(box(view.container).checked).toBe(true);
      await view.unmount();
      await mount({ project: { id: 'p1', name: 'Texts', config: { plaid: { tartan: false } } } });
      expect(box(view.container).checked).toBe(false);
    });

    it('turns off on a click, against what it read, and refreshes the project', async () => {
      const onSaved = vi.fn();
      await mount({ onSaved });
      await view.step(() => box(view.container).click());
      expect(box(view.container).checked).toBe(false);
      expect(client.projects.setConfig).toHaveBeenCalledWith(
        'p1',
        'plaid',
        'tartan',
        false,
        undefined,
        { expected: undefined },
      );
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it('puts the switch back when the save fails', async () => {
      client.projects.setConfig = vi.fn(async () => {
        throw new Error('down');
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await mount();
        await view.step(() => box(view.container).click());
        expect(box(view.container).checked).toBe(true);
        expect(notify.notifyError).toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('Research', () => {
    const box = (root) =>
      all(root, 'label')
        .find((l) => l.textContent.includes('Record responses to suggestions'))
        ?.querySelector('input[type="checkbox"]');

    beforeEach(() => {
      client.events = { setEnabled: vi.fn() };
    });

    it('is drawn only for an app that asks for it, after its sections', async () => {
      await mount();
      expect(box(view.container)).toBeUndefined();
      await view.unmount();
      await mount({ research: true });
      expect(cards(view.container)).toEqual(['Name', 'Research', 'Project plaid', 'Delete']);
      expect(view.container.textContent).toContain(
        'Records when a suggestion is shown to a member, accepted or replaced, and when an assistant plan is expanded.',
      );
    });

    it('is off by default and shows the stored switch', async () => {
      await mount({ research: true });
      expect(box(view.container).checked).toBe(false);
      await view.unmount();
      await mount({
        research: true,
        project: { id: 'p1', name: 'Texts', config: { plaid: { research: { telemetry: true } } } },
      });
      expect(box(view.container).checked).toBe(true);
    });

    it('saves on a click, tells the recorder and refreshes the project', async () => {
      const onSaved = vi.fn();
      await mount({ research: true, onSaved });
      await view.step(() => box(view.container).click());
      expect(box(view.container).checked).toBe(true);
      expect(client.projects.setConfig).toHaveBeenCalledWith(
        'p1',
        'plaid',
        'research',
        { telemetry: true },
        undefined,
        // What the page read: nothing stored yet.
        { expected: undefined },
      );
      expect(client.events.setEnabled).toHaveBeenCalledWith('p1', true);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it('turns off the same way', async () => {
      await mount({
        research: true,
        project: { id: 'p1', name: 'Texts', config: { plaid: { research: { telemetry: true } } } },
      });
      await view.step(() => box(view.container).click());
      expect(client.projects.setConfig).toHaveBeenCalledWith(
        'p1',
        'plaid',
        'research',
        { telemetry: false },
        undefined,
        { expected: { telemetry: true } },
      );
      expect(client.events.setEnabled).toHaveBeenCalledWith('p1', false);
    });

    it('puts the box back and says so when the save fails', async () => {
      client.projects.setConfig = vi.fn(async () => {
        throw new Error('nope');
      });
      await mount({ research: true });
      await view.step(() => box(view.container).click());
      expect(box(view.container).checked).toBe(false);
      expect(client.events.setEnabled).not.toHaveBeenCalled();
      expect(notify.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});
