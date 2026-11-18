// A dialog opened from a plain button (no Radix Trigger) sends focus back to
// that button when it closes, instead of leaving it on the page's body.
import { describe, it, expect } from 'vitest';
import { act, useState } from 'react';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog.jsx';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from './alert-dialog.jsx';

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

const escape = async () => {
  const content = document.body.querySelector('[role=dialog],[role=alertdialog]');
  await act(async () => {
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
};

const PlainDialog = ({ withBefore = false, removeOpener = false }) => {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState(true);
  return (
    <div>
      {withBefore && <button data-id="before">Before</button>}
      {opener && (
        <button
          data-id="opener"
          onClick={() => {
            setOpen(true);
            if (removeOpener) setOpener(false);
          }}
        >
          New
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>Name it.</DialogDescription>
          <input aria-label="Name" autoFocus />
        </DialogContent>
      </Dialog>
    </div>
  );
};

const press = async (selector) => {
  const el = document.body.querySelector(selector);
  await act(async () => {
    el.focus();
    el.click();
  });
  await settle();
};

describe('Dialog focus return', () => {
  it('puts focus back on the button that opened it', async () => {
    const view = await renderComponent(<PlainDialog />);
    await press('[data-id=opener]');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Name');
    await escape();
    expect(document.body.querySelector('[role=dialog]')).toBe(null);
    expect(document.activeElement).toBe(document.body.querySelector('[data-id=opener]'));
    await view.unmount();
  });

  it('passes over an opener that is gone for the one focused before it', async () => {
    const view = await renderComponent(<PlainDialog withBefore removeOpener />);
    await act(async () => document.body.querySelector('[data-id=before]').focus());
    await press('[data-id=opener]');
    await escape();
    expect(document.activeElement).toBe(document.body.querySelector('[data-id=before]'));
    await view.unmount();
  });

  it('leaves focus alone when focus had gone to the page before opening', async () => {
    const view = await renderComponent(<PlainDialog withBefore removeOpener />);
    await act(async () => document.body.querySelector('[data-id=before]').focus());
    await act(async () => document.activeElement.blur());
    await settle();
    const opener = document.body.querySelector('[data-id=opener]');
    // A click that does not focus its button (Safari).
    await act(async () => opener.click());
    await settle();
    await escape();
    expect(document.activeElement).not.toBe(document.body.querySelector('[data-id=before]'));
    await view.unmount();
  });

  it('does the same for an alert dialog', async () => {
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-id="opener" onClick={() => setOpen(true)}>
            Delete
          </button>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent>
              <AlertDialogTitle>Delete?</AlertDialogTitle>
              <AlertDialogDescription>Gone for good.</AlertDialogDescription>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      );
    };
    const view = await renderComponent(<Harness />);
    await press('[data-id=opener]');
    expect(document.activeElement.textContent).toBe('Cancel');
    await escape();
    expect(document.activeElement).toBe(document.body.querySelector('[data-id=opener]'));
    await view.unmount();
  });

  // FLK5-3: umr's Delete node with its confirm put focus on the deleted node's
  // parent, and the dialog's close took it back to a node focused before.
  it('leaves focus where the confirmed action put it', async () => {
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-id="opener" onClick={() => setOpen(true)}>
            Delete
          </button>
          <button data-id="next">Next</button>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent>
              <AlertDialogTitle>Delete?</AlertDialogTitle>
              <AlertDialogDescription>Gone for good.</AlertDialogDescription>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-id="ok"
                onClick={() =>
                  // As a confirm's caller does once its answer arrives.
                  setTimeout(() => document.body.querySelector('[data-id=next]').focus(), 0)
                }
              >
                Delete
              </AlertDialogAction>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      );
    };
    const view = await renderComponent(<Harness />);
    await press('[data-id=opener]');
    await press('[data-id=ok]');
    expect(document.body.querySelector('[role=alertdialog]')).toBe(null);
    expect(document.activeElement).toBe(document.body.querySelector('[data-id=next]'));
    await view.unmount();
  });

  it('gives the close button a visible focus ring', async () => {
    const view = await renderComponent(<PlainDialog />);
    await press('[data-id=opener]');
    const close = [...document.body.querySelectorAll('[role=dialog] button')].find(
      (b) => b.textContent === 'Close',
    );
    expect(close.className).toContain('focus-visible:ring-2');
    expect(close.className).not.toMatch(/(^|\s)focus:outline-none/);
    await escape();
    await view.unmount();
  });
});
