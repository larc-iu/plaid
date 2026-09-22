// Text typed and not saved: every way out of the screen asks the same
// question. The tab strip's half of it is tabs.test.jsx; this is the rest —
// an in-app link, the browser's Back, and the reload prompt.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('../components/shared/ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { useUnsavedDraft, hasUnsavedDraft } = await import('./useUnsavedDraft.js');

let followed = 0;

const Harness = ({ what }) => {
  useUnsavedDraft(what);
  return (
    <div>
      {/* An ordinary in-app link. Its own handler stands in for the router's:
          it runs only if the click was allowed through. */}
      <a
        href="#/projects/p1/documents"
        id="away"
        onClick={(e) => {
          e.preventDefault();
          followed += 1;
        }}
      >
        Documents
      </a>
      {/* A tab trigger, which `Tabs` asks about itself on mousedown. */}
      <a href="#/projects/p1/documents/d1?tab=analyze" id="tabby" role="tab">
        Analyze
      </a>
    </div>
  );
};

const flush = () => act(async () => {});

const mount = (what) => renderComponent(<Harness what={what} />);

const clickOn = (view, id) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  view.container.querySelector(`#${id}`).dispatchEvent(event);
  return event;
};

beforeEach(() => {
  followed = 0;
  confirm.mockReset();
  confirm.mockResolvedValue(false);
});

afterEach(async () => {
  await flush();
});

describe('an unsaved draft', () => {
  it('is nothing to ask about while nothing is typed', async () => {
    const view = await mount(null);
    expect(hasUnsavedDraft()).toBe(null);
    const event = clickOn(view, 'away');
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true); // the link's own handler, not ours
    expect(followed).toBe(1);
    await view.unmount();
    await flush();
  });

  it('asks before an in-app link takes the page, and stays put on no', async () => {
    const view = await mount('The graph you have typed');
    expect(hasUnsavedDraft()).toBe('The graph you have typed');
    clickOn(view, 'away');
    await flush();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'The graph you have typed is not saved. Leaving loses it.',
        confirmLabel: 'Leave',
        destructive: true,
      }),
    );
    // Nothing navigated behind the question, and the draft is still there.
    expect(followed).toBe(0);
    expect(hasUnsavedDraft()).toBe('The graph you have typed');
    await view.unmount();
    await flush();
  });

  it('lets the link do what it would have done on yes', async () => {
    confirm.mockResolvedValue(true);
    const view = await mount('The graph you have typed');
    clickOn(view, 'away');
    await flush();
    await flush();
    expect(followed).toBe(1);
    expect(hasUnsavedDraft()).toBe(null);
    await view.unmount();
    await flush();
  });

  it('leaves a tab trigger to the tab strip, so nobody is asked twice', async () => {
    const view = await mount('The graph you have typed');
    clickOn(view, 'tabby');
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    await view.unmount();
    await flush();
  });

  it('asks when Back lands on the page again', async () => {
    const view = await mount('The graph you have typed');
    // One extra history entry stands in front of the page while a draft
    // exists, so the first Back is a popstate here rather than a navigation.
    await act(async () => {
      window.dispatchEvent(new Event('popstate'));
    });
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    await view.unmount();
    await flush();
  });

  it('asks the browser to ask, on a reload or a closed window', async () => {
    const view = await mount('The graph you have typed');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await view.unmount();
    await flush();

    // And says nothing once there is nothing to lose.
    const quiet = await mount(null);
    const second = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    await quiet.unmount();
    await flush();
  });
});
