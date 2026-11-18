import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { LanguagesSettings } from './LanguagesSettings.jsx';

// The object and meta language boxes have the same fields, so each box is a
// group named by its title, and a screen reader says which "Name" it is in.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

describe('LanguagesSettings', () => {
  it('names each language box after its title', async () => {
    const project = { id: 'p-1', textLayers: [], config: { igt: {} } };
    const view = await renderComponent(
      <MemoryRouter>
        <LanguagesSettings project={project} projectId="p-1" client={{}} />
      </MemoryRouter>,
    );
    const groups = [...view.container.querySelectorAll('[role=group]')].map((g) => ({
      name: document.getElementById(g.getAttribute('aria-labelledby'))?.textContent.trim(),
      inputs: g.querySelectorAll('input').length,
    }));
    expect(groups.map((g) => g.name)).toEqual(['Object language', 'Meta language']);
    for (const g of groups) expect(g.inputs).toBeGreaterThan(0);
    // An example in an empty field reads as an example, not a value.
    const examples = [...view.container.querySelectorAll('input[placeholder]')].map((i) =>
      i.getAttribute('placeholder'),
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const e of examples) expect(e).toMatch(/^e\.g\. /);
    await view.unmount();
  });

  // H11-2: an edit not saved yet is asked about before the section is left.
  it('stands as unsaved until it is saved', async () => {
    const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');
    const project = { id: 'p-1', textLayers: [], config: { igt: {} } };
    const view = await renderComponent(
      <MemoryRouter>
        <LanguagesSettings project={project} projectId="p-1" client={{}} />
      </MemoryRouter>,
    );
    const input = view.container.querySelector('[role=group] input');
    expect(hasUnsavedDraft()).toBeNull();
    await view.step(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Lezgi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(hasUnsavedDraft()).toBe('What you have typed here');
    await view.unmount();
    expect(hasUnsavedDraft()).toBeNull();
  });

  // H11-4: coordinates are numbers in range. Anything else is flagged and
  // not saved, and a saved coordinate leaves nothing unsaved behind.
  it('saves coordinates as numbers in range, and refuses anything else', async () => {
    const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');
    const server = { id: 'p-1', textLayers: [], config: { igt: {} } };
    const setConfig = vi.fn(async (_id, ns, key, value) => {
      server.config[ns] = { ...server.config[ns], [key]: structuredClone(value) };
    });
    const client = { projects: { setConfig } };
    let view;
    const page = () => (
      <MemoryRouter>
        <LanguagesSettings
          project={structuredClone(server)}
          projectId="p-1"
          client={client}
          onProjectUpdate={() => view.rerender(page())}
        />
      </MemoryRouter>
    );
    view = await renderComponent(page());
    const field = (id) => view.container.querySelector(`#obj-lang-${id}`);
    const put = (id, v) =>
      view.step(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field(id), v);
        field(id).dispatchEvent(new Event('input', { bubbles: true }));
      });
    const saveButton = () =>
      [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    await put('lat', 'north');
    expect(field('lat').getAttribute('aria-invalid')).toBe('true');
    expect(view.container.textContent).toContain('Latitude is a number from -90 to 90.');
    expect(saveButton().disabled).toBe(true);
    await put('lat', '41.5');
    await put('lon', '999');
    expect(view.container.textContent).toContain('Longitude is a number from -180 to 180.');
    expect(saveButton().disabled).toBe(true);
    await put('lon', '48');
    expect(saveButton().disabled).toBe(false);
    await view.step(async () => {
      saveButton().click();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(setConfig.mock.calls[0][3].object).toMatchObject({ latitude: 41.5, longitude: 48 });
    expect(saveButton().disabled).toBe(true);
    expect(hasUnsavedDraft()).toBeNull();
    await view.unmount();
  });

  // REV-U3-1: a writing system tag is stored as typed, one the browser
  // cannot read too (a private-use tag, a Glottocode, `en_US`).
  for (const tag of ['x-kukama', 'stan1293', 'en_US', 'zh-yue', 'lez']) {
    it(`saves the writing system tag ${tag}`, async () => {
      const setConfig = vi.fn(async () => {});
      const project = { id: 'p-1', textLayers: [], config: { igt: {} } };
      const view = await renderComponent(
        <MemoryRouter>
          <LanguagesSettings
            project={project}
            projectId="p-1"
            client={{ projects: { setConfig } }}
          />
        </MemoryRouter>,
      );
      const field = view.container.querySelector('#obj-lang-tag');
      await view.step(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, tag);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await view.step(async () => {
        [...view.container.querySelectorAll('button')]
          .find((b) => b.textContent === 'Save')
          .click();
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      });
      expect(setConfig.mock.calls[0][3].object.tag).toBe(tag);
      await view.unmount();
    });
  }
});
