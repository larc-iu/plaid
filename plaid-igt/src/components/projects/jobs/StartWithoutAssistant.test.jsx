import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantFresh } from '@ui/components/assistant/subject.js';
import { serviceCache } from '@ui/components/assistant/jobs.js';

// The Jobs tab's "⋯" menu: Start without the assistant opens the Start job
// form, and asks the assistant for nothing.
const feedback = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { StartWithoutAssistant } = await import('./StartJobDialog.jsx');

const ASSISTANT = {
  serviceId: 'igt:assist:m',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 3 },
};

const clientOf = (services = [ASSISTANT]) => ({
  jobs: {
    worker: vi.fn(async () => ({
      seenAt: new Date().toISOString(),
      model: 'm',
      instructionsMaxChars: 400,
      documentsMax: 10,
    })),
    create: vi.fn(),
  },
  projects: { listDocuments: vi.fn(async () => [{ id: 'd1', name: 'Story A' }]) },
  messages: { discoverServices: vi.fn(async () => services) },
});

// What the panel would take: the request for a new conversation.
const Panel = ({ seen }) => {
  seen.fresh = useAssistantFresh().fresh;
  return null;
};

const mount = async (element, seen) => {
  const v = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <AssistantSubjectProvider>
        <Routes>
          <Route
            path="*"
            element={
              <>
                {element}
                <Panel seen={seen} />
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

const dialogTitle = () => document.body.querySelector('[role="dialog"] h2')?.textContent ?? null;

beforeEach(() => {
  serviceCache.clear();
  window.innerWidth = 1280;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('Start without the assistant', () => {
  it('is a "⋯" menu, reachable by keyboard, whose item opens the Start job form', async () => {
    const seen = {};
    const v = await mount(<StartWithoutAssistant projectId="p1" client={clientOf()} />, seen);
    const trigger = all(v.container, 'button').find(
      (b) => b.getAttribute('aria-label') === 'More job actions',
    );
    expect(trigger).toBeTruthy();
    await v.step(() => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const item = all(document.body, '[role="menuitem"]').find(
      (i) => i.textContent.trim() === 'Start without the assistant',
    );
    expect(item).toBeTruthy();
    await v.step(() => item.click());
    await v.step(async () => {});
    expect(dialogTitle()).toBe('Start job');
    expect(seen.fresh).toBeNull();
    await v.unmount();
  });

  it('gives focus back to its trigger on Escape', async () => {
    const v = await mount(<StartWithoutAssistant projectId="p1" client={clientOf()} />, {});
    const trigger = all(v.container, 'button').find(
      (b) => b.getAttribute('aria-label') === 'More job actions',
    );
    await v.step(() => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    await v.step(() =>
      document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    // The menu leaves and hands focus back a task or two after the key, so
    // the test waits for the focus itself.
    await vi.waitFor(async () => {
      await v.step(async () => {});
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    await v.unmount();
  });
});
