import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { LanguagesSettings } from './LanguagesSettings.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';
import { BUILT_IN_TABLE } from '@/domain/composeConfig';

// The settings screens re-read the project after any save, their own or
// another tab's. A form with edits not saved yet keeps them. A form with none
// shows what the server has now.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const typeInto = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// A fresh project object each time, as a re-read hands one down.
const project = (igt) => ({ id: 'p-1', textLayers: [], config: { igt } });

describe('LanguagesSettings on a re-read', () => {
  const mount = (igt) => (
    <MemoryRouter>
      <LanguagesSettings project={project(igt)} projectId="p-1" client={{}} />
    </MemoryRouter>
  );
  const metaName = (c) => c.querySelector('#meta-lang-name');
  const objName = (c) => c.querySelector('#obj-lang-name');

  it('keeps an edit not saved yet', async () => {
    const view = await renderComponent(mount({}));
    await view.step(async () => typeInto(objName(view.container), 'Lezgian'));
    await view.rerender(mount({ languages: { meta: { name: 'English' } } }));
    expect(objName(view.container).value).toBe('Lezgian');
    await view.unmount();
  });

  it('shows what the server has when nothing was edited', async () => {
    const view = await renderComponent(mount({}));
    await view.rerender(mount({ languages: { meta: { name: 'English' } } }));
    expect(metaName(view.container).value).toBe('English');
    await view.unmount();
  });
});

describe('ComposeSettings on a re-read', () => {
  const mount = (igt) => (
    <MemoryRouter>
      <ComposeSettings project={project(igt)} projectId="p-1" client={{}} />
    </MemoryRouter>
  );
  const firstRow = (c) => c.querySelector('[data-code-row]');
  const charOf = (row) => row.querySelectorAll('input')[0].value;
  const noteOf = (row) => row.querySelectorAll('input')[1];
  // Another tab points the first built-in code somewhere else.
  const repointed = (code) => ({ compose: { codes: [{ code, char: 'ɓ' }], removed: [] } });

  it('keeps an edit not saved yet', async () => {
    const view = await renderComponent(mount({}));
    const code = firstRow(view.container).dataset.codeRow;
    await view.step(async () => typeInto(noteOf(firstRow(view.container)), 'mine'));
    await view.rerender(mount(repointed(code)));
    expect(noteOf(firstRow(view.container)).value).toBe('mine');
    expect(charOf(firstRow(view.container))).toBe(BUILT_IN_TABLE[code]);
    await view.unmount();
  });

  it('shows what the server has when nothing was edited', async () => {
    const view = await renderComponent(mount({}));
    const code = firstRow(view.container).dataset.codeRow;
    await view.rerender(mount(repointed(code)));
    expect(charOf(firstRow(view.container))).toBe('ɓ');
    await view.unmount();
  });
});
