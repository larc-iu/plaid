import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { AssistantSubjectProvider } from './AssistantSubject.jsx';
import { readDockOpen, saveDockOpen } from './panelWidth.js';
import { serviceCache } from './jobs.js';
import { useAssistantFresh, useOpenAssistant } from './subject.js';
import { assistantGate, assistantOffered } from './assistantGate.js';

// A screen's own Assistant button (plaid-igt's Documents and Jobs tabs) opens
// the panel as the header chip does: on whatever conversation the panel holds,
// never a new one. The dock is a stand-in that says it is there.
vi.mock('./AssistantDock.jsx', () => ({
  AssistantDock: ({ inert }) => <aside data-testid="dock">{inert ? 'hidden' : 'shown'}</aside>,
}));
const { AssistantChrome } = await import('./AssistantChrome.jsx');

const ASSISTANT = {
  serviceId: 'igt:assist:m',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 3 },
};
const client = () => ({ messages: { discoverServices: vi.fn(async () => [ASSISTANT]) } });

const Screen = ({ seen }) => {
  const open = useOpenAssistant();
  seen.fresh = useAssistantFresh().fresh;
  return (
    <button type="button" data-testid="screen-button" onClick={open}>
      Mine
    </button>
  );
};

let view = null;
const seen = {};
beforeEach(() => {
  serviceCache.clear();
  serviceCache.set('p1', [ASSISTANT]);
  saveDockOpen(false);
  window.innerWidth = 1280;
});
afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  saveDockOpen(false);
});

const mount = async () => {
  view = await renderComponent(
    <AssistantSubjectProvider>
      <AssistantChrome
        adapter={{ app: 'igt' }}
        client={client()}
        user={{ id: 'u1' }}
        subject={{ projectId: 'p1', projectName: 'Lamkang' }}
        routeHasProject
      >
        {({ chip }) => (
          <>
            <header>{chip}</header>
            <Screen seen={seen} />
          </>
        )}
      </AssistantChrome>
    </AssistantSubjectProvider>,
  );
  for (let i = 0; i < 4; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
};
const dock = () => document.body.querySelector('[data-testid="dock"]')?.textContent ?? null;
const chip = () => byText(document.body, 'header button', 'Assistant');
const press = () =>
  view.step(() => document.body.querySelector('[data-testid="screen-button"]').click());

describe("a screen's own Assistant button", () => {
  it('opens the panel as the chip does, on no new conversation, and again after it is shut', async () => {
    await mount();
    expect(chip()).not.toBeNull();
    expect(dock()).toBeNull();
    await press();
    expect(dock()).toBe('shown');
    expect(readDockOpen()).toBe(true);
    expect(seen.fresh).toBeNull();
    // The chip is the way in only while the panel is shut.
    expect(chip()).toBeNull();
  });

  it('is offered on the same rule as the chip: once an assistant is known to be online', () => {
    expect(assistantOffered('p1', true)).toBe(true);
    expect(assistantOffered('p1', null)).toBe(false);
    expect(assistantOffered('p1', false)).toBe(false);
    expect(assistantOffered(null, true)).toBe(false);
    for (const available of [true, false, null]) {
      const { showHandle } = assistantGate({
        wide: true,
        projectId: 'p1',
        available,
        projectScreen: true,
      });
      expect(showHandle).toBe(assistantOffered('p1', available));
    }
  });
});
