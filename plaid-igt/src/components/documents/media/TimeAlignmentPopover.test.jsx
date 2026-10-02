import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { fakeDocument } from '@/test/mountDocumentHook.jsx';

// A segment typed into the timeline popover and refused (it overlaps a
// segment of the same voice) used to be lost the moment the popover closed:
// fixing the selection meant a new drag, and every opening emptied the box.
// Text not saved or cancelled now comes back with the next opening.

vi.mock('@/utils/feedback', () => ({ notifySuccess: vi.fn() }));
const { TimeAlignmentPopover } = await import('./TimeAlignmentPopover.jsx');

afterEach(() => vi.restoreAllMocks());

const tree = (doc, open, selection = { start: 6, end: 8 }) => (
  <DocumentProvider value={{ doc, canWrite: true, readOnly: false }}>
    <TimeAlignmentPopover
      open={open}
      onOpenChange={() => {}}
      selection={selection}
      onAlignmentCreated={() => {}}
      selectionBox={<div />}
    />
  </DocumentProvider>
);

const box = () =>
  document.querySelector('textarea[aria-label="Segment text"], [role="dialog"] textarea');

const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const button = (name) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name);

describe('the timeline popover', () => {
  it('opens again with text a save refused', async () => {
    const doc = fakeDocument({ createAlignment: vi.fn(async () => false), dataVersion: 0 });
    const r = await renderComponent(tree(doc, true));
    await r.step(() => type(box(), 'dunu kata'));
    await r.step(async () => {
      button('Save').click();
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(doc.createAlignment).toHaveBeenCalled();
    // A new drag closes it and opens it on the new selection.
    await r.rerender(tree(doc, false));
    await r.rerender(tree(doc, true, { start: 6.2, end: 8 }));
    expect(box().value).toBe('dunu kata');
    await r.unmount();
  });

  it('opens empty after Cancel', async () => {
    const doc = fakeDocument({ createAlignment: vi.fn(async () => false) });
    const r = await renderComponent(tree(doc, true));
    await r.step(() => type(box(), 'dunu'));
    await r.step(() => button('Cancel').click());
    await r.rerender(tree(doc, false));
    await r.rerender(tree(doc, true));
    expect(box().value).toBe('');
    await r.unmount();
  });
});
