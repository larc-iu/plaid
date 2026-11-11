// A popover opened inside a dialog scrolls under the wheel.
//
// A modal Dialog locks scrolling everywhere outside its own content: its lock
// (react-remove-scroll) listens for `wheel` and `touchmove` on the document and
// cancels any that started outside the dialog. A popover's content is portalled
// to <body>, outside the dialog, so the info bubble beside a run dialog's
// Method could only be scrolled by dragging its scroll bar. Here a cancelled
// wheel is the lock's `preventDefault`, which is what stops the real scroll in
// a browser (e2e/popover-scroll.spec.js scrolls one for real).
import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './popover.jsx';
import { Combobox } from '../shared/combobox.jsx';

const wheel = (target) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

const touchMove = (target) => {
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  event.touches = [{ clientX: 0, clientY: 0 }];
  event.changedTouches = event.touches;
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const inDialog = (children) => (
  <Dialog open>
    <DialogContent>
      <DialogTitle>Auto-analyze</DialogTitle>
      <DialogDescription>Steps</DialogDescription>
      {children}
    </DialogContent>
  </Dialog>
);

describe('a popover inside a modal dialog', () => {
  it('takes the wheel and a swipe, while the page outside the dialog stays locked', async () => {
    view = await renderComponent(
      inDialog(
        <Popover defaultOpen>
          <PopoverTrigger>About</PopoverTrigger>
          <PopoverContent className="max-h-80 overflow-y-auto">
            <p data-testid="inside">A long description.</p>
          </PopoverContent>
        </Popover>,
      ),
    );
    const inside = document.querySelector('[data-testid=inside]');
    expect(inside).not.toBeNull();
    const dialog = [...document.querySelectorAll('[role=dialog]')].find((d) =>
      d.textContent.includes('Auto-analyze'),
    );
    expect(dialog.contains(inside)).toBe(false);
    // The lock is on: a wheel over the page behind the dialog is cancelled.
    expect(wheel(view.container)).toBe(true);
    expect(wheel(inside)).toBe(false);
    expect(touchMove(inside)).toBe(false);
  });

  it("keeps a handler of the caller's own", async () => {
    const seen = [];
    view = await renderComponent(
      inDialog(
        <Popover defaultOpen>
          <PopoverTrigger>About</PopoverTrigger>
          <PopoverContent onWheel={() => seen.push('wheel')}>
            <p data-testid="inside">A long description.</p>
          </PopoverContent>
        </Popover>,
      ),
    );
    expect(wheel(document.querySelector('[data-testid=inside]'))).toBe(false);
    expect(seen).toEqual(['wheel']);
  });

  it("a combobox's list takes the wheel", async () => {
    view = await renderComponent(
      inDialog(
        <Combobox aria-label="Tag" value="" onChange={() => {}} options={['NOUN', 'VERB']} />,
      ),
    );
    const input = document.querySelector('input[role=combobox]');
    await view.step(() => input.focus());
    const option = [...document.querySelectorAll('[role=option]')].find(
      (o) => o.textContent === 'VERB',
    );
    expect(option).toBeTruthy();
    expect(wheel(option)).toBe(false);
  });
});
