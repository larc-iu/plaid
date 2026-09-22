// Text typed and not saved: every way out of the screen asks the same
// question. The tab strip's half of it is tabs.test.jsx; this is the rest:
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
          it runs only if the click was allowed through. It does NOT take the
          page away, which is what makes it the "asked, then stayed" case. */}
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

// Past the end of this task, which is where an approved exit stops counting as
// one: the screen that is still standing here is guarded again.
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// One screen at a time, and never past the test that mounted it: a draft left
// registered by a failed assertion would follow the next test into its own
// history.
let view = null;

const mount = async (what) => {
  view = await renderComponent(<Harness what={what} />);
  return view;
};

const clickOn = (id) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  view.container.querySelector(`#${id}`).dispatchEvent(event);
  return event;
};

// Where in the browser's history the test stands. ONE extra entry is pushed in
// front of the page while a draft exists, so `idx` counts to 1 while it is
// armed and back to 0 once it has been taken out.
const idx = () => window.history.state?.idx;

// The page's own entry, one per test: the tests share a history stack, and
// going back PAST the page lands on whatever the test before it left there.
let pageKey = '';
let pages = 0;

beforeEach(() => {
  followed = 0;
  confirm.mockReset();
  confirm.mockResolvedValue(false);
  // A router-shaped entry for the page itself, so the extra entry has an `idx`
  // to carry forward, as it does under HashRouter.
  pageKey = `page${(pages += 1)}`;
  window.history.pushState({ idx: 0, key: pageKey }, '');
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  await flush();
  await tick();
});

describe('an unsaved draft', () => {
  it('is nothing to ask about while nothing is typed', async () => {
    await mount(null);
    expect(hasUnsavedDraft()).toBe(null);
    // Nothing typed, nothing standing in front of the page.
    expect(idx()).toBe(0);
    const event = clickOn('away');
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true); // the link's own handler, not ours
    expect(followed).toBe(1);
  });

  it('stands one history entry in front of the page, and takes it out again', async () => {
    await mount('The graph you have typed');
    expect(idx()).toBe(1);
    await view.unmount();
    view = null;
    await flush();
    await tick();
    // The screen is gone, so its entry is not left for Back to spend itself on.
    expect(idx()).toBe(0);
  });

  it('asks before an in-app link takes the page, and stays put on no', async () => {
    await mount('The graph you have typed');
    expect(hasUnsavedDraft()).toBe('The graph you have typed');
    clickOn('away');
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
    expect(idx()).toBe(1);
  });

  it('lets the link do what it would have done on yes', async () => {
    confirm.mockResolvedValue(true);
    await mount('The graph you have typed');
    clickOn('away');
    await flush();
    await flush();
    expect(followed).toBe(1);
  });

  // The answer is about ONE way out. This link does not take the page (its own
  // handler stops it), so the text is still on the screen afterwards, and the
  // screen is not left unguarded for the rest of its life.
  it('asks again the next time, when the Leave did not leave', async () => {
    confirm.mockResolvedValue(true);
    await mount('The graph you have typed');

    clickOn('away');
    await flush();
    await tick();
    expect(followed).toBe(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    // Still typed, still guarded: the entry went out of Back's way for the
    // click, and stood back up when the click left the screen where it was.
    expect(hasUnsavedDraft()).toBe('The graph you have typed');
    expect(idx()).toBe(1);

    clickOn('away');
    await flush();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(followed).toBe(2);

    // And the browser is still asked to ask on a reload.
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a tab trigger to the tab strip, so nobody is asked twice', async () => {
    await mount('The graph you have typed');
    clickOn('tabby');
    await flush();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks when Back lands on the page again, and stands the entry back up on no', async () => {
    await mount('The graph you have typed');
    expect(idx()).toBe(1);
    // A real Back: the extra entry is spent and the page's own entry is under
    // it, carrying the same URL, so this re-renders rather than navigating.
    await act(async () => {
      window.history.back();
    });
    await flush();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(idx()).toBe(1);
  });

  it('goes the rest of the way back on yes, and asks once on the way', async () => {
    confirm.mockResolvedValue(true);
    await mount('The graph you have typed');
    await act(async () => {
      window.history.back();
    });
    await flush();
    await tick();
    // Past the page's own entry, to whatever the reader came from. The
    // traversal's own popstate is this same exit landing, not a second Back.
    expect(window.history.state?.key).not.toBe(pageKey);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('asks the browser to ask, on a reload or a closed window', async () => {
    await mount('The graph you have typed');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await view.unmount();
    view = null;
    await flush();
    await tick();

    // And says nothing once there is nothing to lose.
    await mount(null);
    const second = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });
});
