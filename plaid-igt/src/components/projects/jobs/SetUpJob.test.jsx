import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantFresh } from '@ui/components/assistant/subject.js';
import { serviceCache } from '@ui/components/assistant/jobs.js';

// Set up job (BRIEF-SU): a job is set up in a new assistant conversation
// marked job-setup. The docked panel opens on it where the window has room,
// the full Assistant tab where it has not, and the Start job form where no
// assistant is online for the project. The form, unchanged, is also on the
// Jobs tab's "⋯" menu as Start without the assistant.
const feedback = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { SetUpJob, StartWithoutAssistant } = await import('./StartJobDialog.jsx');

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
const Where = ({ seen }) => {
  const { pathname, search } = useLocation();
  seen.at = `${pathname}${search}`;
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

const dialogTitle = () => document.body.querySelector('[role="dialog"] h2')?.textContent ?? null;
const press = (v, label) => v.step(() => byText(v.container, 'button', label).click());

beforeEach(() => {
  serviceCache.clear();
  window.innerWidth = 1280;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('Set up job', () => {
  it('opens the docked panel on a new job setup conversation, where an assistant is online', async () => {
    const seen = {};
    const v = await mount(<SetUpJob projectId="p1" client={clientOf()} />, seen);
    expect(seen.fresh).toBeNull();
    await press(v, 'Set up job');
    expect(seen.fresh).toMatchObject({ purpose: 'job-setup' });
    expect(dialogTitle()).toBeNull();
    expect(seen.at).toBe('/projects/p1');
    await v.unmount();
  });

  it('opens the full Assistant tab on one where the window has no room for the panel', async () => {
    window.innerWidth = 800;
    const seen = {};
    const v = await mount(<SetUpJob projectId="p1" client={clientOf()} />, seen);
    await press(v, 'Set up job');
    expect(seen.at).toBe('/projects/p1?tab=assistant&purpose=job-setup');
    expect(seen.fresh).toBeNull();
    expect(dialogTitle()).toBeNull();
    await v.unmount();
  });

  it('opens the Start job form where no assistant is online', async () => {
    const seen = {};
    const v = await mount(<SetUpJob projectId="p1" client={clientOf([])} />, seen);
    await press(v, 'Set up job');
    await v.step(async () => {});
    expect(dialogTitle()).toBe('Start job');
    expect(seen.fresh).toBeNull();
    await v.unmount();
  });

  it('draws the same button small in a document header', async () => {
    const seen = {};
    const v = await mount(
      <SetUpJob projectId="p1" client={clientOf()} documentId="d1" small />,
      seen,
    );
    const button = byText(v.container, 'button', 'Set up job');
    expect(button).toBeTruthy();
    await press(v, 'Set up job');
    expect(seen.fresh).toMatchObject({ purpose: 'job-setup' });
    await v.unmount();
  });
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
});
