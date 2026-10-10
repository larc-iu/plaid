import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useTabParam } from '@ui/hooks/useTabParam.js';
import { useIslandTabRequests } from './useIslandTabRequests.js';

// The Analyze island is not React, and asks for another tab by a window event.
// The ways that goes wrong are quiet: a handler left over from an older render
// writes the tab onto an older URL, and one left behind by a screen that is gone
// moves a tab nobody is on.

const TABS = ['baseline', 'tokenize', 'analyze'];

// The probe hands what it knows out on a stable object, since a test cannot
// read a navigate off the DOM.
const hook = {};
const last = () => hook.last;

const Probe = () => {
  const [activeTab, setActiveTab] = useTabParam(TABS, 'baseline', { writeFallback: true });
  useIslandTabRequests(setActiveTab);
  const { search } = useLocation();
  hook.navigate = useNavigate();
  hook.last = { activeTab, search };
  return null;
};

const mount = (entries) =>
  renderComponent(
    <MemoryRouter initialEntries={entries}>
      <Probe />
    </MemoryRouter>,
  );

const ask = (detail) => window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail }));

// Every handler the hook registered for `event`, in the order it registered them.
const handlersFor = (spy, event) =>
  spy.mock.calls.filter(([type]) => type === event).map(([, fn]) => fn);

afterEach(() => vi.restoreAllMocks());

describe('a tab the island asks for', () => {
  it('is switched to', async () => {
    const view = await mount(['/d?tab=analyze']);
    await view.step(() => ask({ tab: 'tokenize' }));
    expect(last().activeTab).toBe('tokenize');
    await view.unmount();
  });

  it('is written onto the URL as it is now, not as it was', async () => {
    // The listener is re-subscribed when the setter changes, because the setter
    // closes over the query string it was made under. A handler left over from
    // an older one writes the tab onto that older URL, and everything the
    // address has picked up since (a focused sentence, a search) is dropped.
    const view = await mount(['/d?tab=analyze']);
    await view.step(() => hook.navigate('/d?tab=analyze&focusSentence=s3'));
    expect(last().search).toBe('?tab=analyze&focusSentence=s3');

    await view.step(() => ask({ tab: 'tokenize' }));
    expect(last().search).toBe('?tab=tokenize&focusSentence=s3');
    await view.unmount();
  });

  it('is ignored when the event names no tab', async () => {
    const view = await mount(['/d?tab=analyze']);
    await view.step(() => ask({}));
    expect(last().activeTab).toBe('analyze');
    await view.unmount();
  });

  it('is no longer heard once the screen is gone', async () => {
    // Every handler the hook added has to come off again. The setter changes
    // with the query string, so there is a pair per subscription.
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const view = await mount(['/d?tab=analyze']);
    const registered = handlersFor(added, 'igt:navigate-tab');
    expect(registered.length).toBeGreaterThan(0);

    await view.unmount();
    const dropped = handlersFor(removed, 'igt:navigate-tab');
    expect(registered.filter((fn) => !dropped.includes(fn))).toEqual([]);

    ask({ tab: 'tokenize' });
    expect(last().activeTab).toBe('analyze');
  });
});
