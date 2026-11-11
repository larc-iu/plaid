import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { AssistantChrome } from './AssistantChrome.jsx';
import { saveDockOpen } from './panelWidth.js';
import { serviceCache } from './jobs.js';

// The panel on a screen that is not a project's own, the screen a reader lands
// on. Which projects have an assistant is known only per project, so the way in
// is offered there whatever the answer. Picking a project with none closed the
// panel and took the button with it, with nothing said.

const ADAPTER = { app: 'ud' };

const client = () => ({
  projects: { list: vi.fn(async () => [{ id: 'p-quiet', name: 'Quiet project' }]) },
  messages: { discoverServices: vi.fn(async () => []) },
});

let view = null;
beforeEach(() => {
  serviceCache.clear?.();
  saveDockOpen(true);
});
afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  saveDockOpen(false);
});

const mount = async (c) => {
  view = await renderComponent(
    <AssistantChrome adapter={ADAPTER} client={c} user={{ id: 'u1' }}>
      {({ chip }) => <header>{chip}</header>}
    </AssistantChrome>,
  );
  for (let i = 0; i < 5; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
};

describe('the project picker', () => {
  it('stays open and says so when the project picked has no assistant', async () => {
    const c = client();
    await mount(c);
    const pick = byText(document.body, 'aside button', 'Quiet project');
    expect(pick).not.toBeNull();

    await view.step(() => pick.click());
    for (let i = 0; i < 5; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));

    expect(c.messages.discoverServices).toHaveBeenCalledWith('p-quiet');
    const aside = document.body.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside.textContent).toContain('No assistant is running for “Quiet project”.');
    // The list stays, so another project can be picked.
    expect(byText(aside, 'button', 'Quiet project')).not.toBeNull();
  });
});
