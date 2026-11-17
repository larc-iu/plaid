import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantFresh, useAssistantOpenRequest } from '@ui/components/assistant/subject.js';
import { serviceCache } from '@ui/components/assistant/jobs.js';
import { AssistantButton } from './AssistantButton.jsx';

// The Assistant button beside New document and on the Jobs tab: the header
// chip's twin. It opens the docked panel on whatever conversation it holds
// where the window has room for it, and the project's Assistant tab where it
// has not. With no assistant known to be online it is not there, as the chip
// is not.

const ASSISTANT = {
  serviceId: 'igt:assist:m',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 3 },
};
const clientOf = (services = [ASSISTANT]) => ({
  messages: { discoverServices: vi.fn(async () => services) },
});

// What the shell would take: a request to open the panel, and none for a new
// conversation.
const Shell = ({ seen }) => {
  seen.opened = useAssistantOpenRequest();
  seen.fresh = useAssistantFresh().fresh;
  return null;
};
const Where = ({ seen }) => {
  const { pathname, search } = useLocation();
  seen.at = `${pathname}${search}`;
  return null;
};

const mount = async (client, seen) => {
  const v = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <AssistantSubjectProvider>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AssistantButton projectId="p1" client={client} />
                <Shell seen={seen} />
                <Where seen={seen} />
              </>
            }
          />
        </Routes>
      </AssistantSubjectProvider>
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await v.step(() => new Promise((r) => setTimeout(r, 0)));
  return v;
};
const control = (v) => byText(v.container, 'button, a', 'Assistant');

beforeEach(() => {
  serviceCache.clear();
  window.innerWidth = 1280;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('the Assistant button', () => {
  it('opens the docked panel as the chip does, on no new conversation', async () => {
    const seen = {};
    const v = await mount(clientOf(), seen);
    const button = control(v);
    expect(button.tagName).toBe('BUTTON');
    expect(seen.opened).toBe(0);
    await v.step(() => button.click());
    expect(seen.opened).toBe(1);
    expect(seen.fresh).toBeNull();
    expect(seen.at).toBe('/projects/p1');
    await v.step(() => button.click());
    expect(seen.opened).toBe(2);
    await v.unmount();
  });

  it('is a link to the Assistant tab where the window has no room for the panel', async () => {
    window.innerWidth = 800;
    const seen = {};
    const v = await mount(clientOf(), seen);
    const link = control(v);
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/projects/p1?tab=assistant');
    await v.step(() => link.click());
    expect(seen.at).toBe('/projects/p1?tab=assistant');
    expect(seen.opened).toBe(0);
    expect(seen.fresh).toBeNull();
    await v.unmount();
  });

  it('is not there with no assistant online, nor before discovery answers', async () => {
    const none = await mount(clientOf([]), {});
    expect(control(none)).toBeNull();
    await none.unmount();
    const client = clientOf();
    client.messages.discoverServices = vi.fn(() => new Promise(() => {}));
    const unknown = await mount(client, {});
    expect(control(unknown)).toBeNull();
    await unknown.unmount();
  });

  it('reads Assistant beside the assistant’s mark, as the chip does', async () => {
    const v = await mount(clientOf(), {});
    const button = control(v);
    expect(button.textContent.trim()).toBe('Assistant');
    expect(button.querySelector('svg clipPath')).not.toBeNull();
    await v.unmount();
  });
});
