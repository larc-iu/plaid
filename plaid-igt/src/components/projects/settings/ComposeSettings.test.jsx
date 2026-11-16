import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';

// Settings → Text and vocab → Special characters: the list of a project's
// backslash codes, sortable by each column, with what was deleted gone.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// A project whose stored config the page writes into, read again on each save.
const open = async (compose) => {
  const server = { id: 'p-1', textLayers: [], config: { igt: compose ? { compose } : {} } };
  const client = {
    projects: {
      setConfig: async (_id, ns, key, value) => {
        server.config[ns][key] = structuredClone(value);
      },
    },
  };
  let view;
  const props = () => ({
    project: structuredClone(server),
    projectId: 'p-1',
    client,
    onProjectUpdate: () =>
      view.rerender(
        <MemoryRouter>
          <ComposeSettings {...props()} />
        </MemoryRouter>,
      ),
  });
  view = await renderComponent(
    <MemoryRouter>
      <ComposeSettings {...props()} />
    </MemoryRouter>,
  );
  const reopen = async () => {
    await view.unmount();
    view = await renderComponent(
      <MemoryRouter>
        <ComposeSettings {...props()} />
      </MemoryRouter>,
    );
    page.view = view;
  };
  const page = { server, view, reopen };
  return page;
};

const codes = (c) => [...c.querySelectorAll('[data-code-row]')].map((r) => r.dataset.codeRow);
const row = (c, code) => c.querySelector(`[data-code-row="${code}"]`);
const button = (c, name) =>
  [...c.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name || b.getAttribute('aria-label') === name,
  );
const search = (view, text) =>
  view.step(() => type(view.container.querySelector('input[aria-label="Search codes"]'), text));
beforeEach(() => localStorage.clear());

describe('the labels', () => {
  it('labels a row’s fields Code and Character', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const fresh = row(view.container, '');
    expect(fresh.querySelector('input[aria-label="Code"]')).not.toBeNull();
    expect(fresh.querySelector('input[aria-label="Character"]')).not.toBeNull();
    await search(view, 'sw');
    expect(row(view.container, 'sw').querySelector('input[aria-label="Character"]')).not.toBe(null);
    await view.unmount();
  });

  it('has no paragraph about the length of a code or Praat', async () => {
    const { view } = await open();
    const text = view.container.textContent;
    expect(text).not.toContain('A code is exactly');
    expect(text).not.toContain('never a space or a backslash');
    expect(text).not.toContain('built-in codes, taken from Praat');
    expect(text).not.toContain('a code you already know from there works here');
    await view.unmount();
  });

  it('puts no example text in a new row', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const fresh = row(view.container, '');
    for (const input of fresh.querySelectorAll('input')) {
      expect(input.getAttribute('placeholder') ?? '').toBe('');
    }
    expect(view.container.innerHTML).not.toContain('implosive b');
    await view.unmount();
  });

  it('says what an empty field needs only when it is wrong, in the fewest words', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const text = () => row(view.container, '').textContent;
    expect(view.container.textContent).not.toContain('Give the character this code types.');
    expect(text()).toContain('A code is 2 characters.');
    expect(text()).toContain('Enter a character.');
    await view.step(() => type(row(view.container, '').querySelector('input'), 'zq'));
    expect(row(view.container, 'zq').textContent).not.toContain('A code is 2 characters.');
    await view.unmount();
  });
});
