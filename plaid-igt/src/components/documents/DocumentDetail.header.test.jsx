import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { serviceCache } from '@ui/components/assistant/jobs.js';

// A document's header holds History and, only on a window too narrow for the
// assistant panel (where the header chip and the edge rail are not drawn), a
// link to the project's Assistant tab, so the assistant can always be reached
// (DOC found 8). No button there sets up a job (the owner, 2026-11-17). The
// shell is a stand-in that hands the test what IGT gave it.
const shell = vi.hoisted(() => ({ app: null }));
vi.mock('@ui/components/shared/DocumentEditorShell.jsx', () => ({
  DocumentEditorShell: ({ app }) => {
    shell.app = app;
    return null;
  },
}));
vi.mock('./contexts/StrictModeContext.jsx', () => ({ useStrictClient: () => ({}) }));

const { DocumentDetail } = await import('./DocumentDetail.jsx');

const ASSISTANT = {
  serviceId: 'igt:assist:m',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 3 },
};
const clientOf = (services) => ({
  messages: { discoverServices: vi.fn(async () => services) },
});

const actions = async (width, services = [ASSISTANT]) => {
  window.innerWidth = width;
  window.dispatchEvent(new Event('resize'));
  const v = await renderComponent(<DocumentDetail />);
  await v.unmount();
  const drawn = await renderComponent(
    <MemoryRouter>
      {shell.app.headerActions({ projectId: 'p1', client: clientOf(services) })}
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await drawn.step(() => new Promise((r) => setTimeout(r, 0)));
  return drawn;
};

beforeEach(() => serviceCache.clear());

describe("a document's header", () => {
  it('has no action of the app’s own beside History where the panel has room', async () => {
    const v = await actions(1440);
    expect(v.container.textContent).toBe('');
    await v.unmount();
  });

  it('links the Assistant tab on a narrow window, while an assistant is online', async () => {
    const v = await actions(800);
    // The mark alone, named Assistant: the word beside History pushed the
    // two onto a second line of the sticky strip at 768 px (REV-SVU-10).
    const links = all(v.container, 'a');
    expect(
      links.map((a) => [
        a.getAttribute('aria-label'),
        a.textContent.trim(),
        a.getAttribute('href'),
      ]),
    ).toEqual([['Assistant', '', '/projects/p1?tab=assistant']]);
    expect(links[0].getAttribute('title')).toBe('Assistant');
    expect(v.container.textContent).not.toMatch(/job/i);
    await v.unmount();
    const none = await actions(800, []);
    expect(none.container.textContent).toBe('');
    await none.unmount();
  });
});
