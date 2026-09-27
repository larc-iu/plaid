// The "are you sure" with a live body wears the same look as every other
// destructive confirm (useConfirm): a red triangle in the title, the body as
// muted text, and a solid red button carrying only its verb. The red warning
// box and the trash icon of the old look are gone.
import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.jsx';

const dialog = () => document.body.querySelector('[role=alertdialog]');
const button = (text) =>
  all(document.body, '[role=alertdialog] button').find((b) => b.textContent.trim() === text);

const mount = (props = {}) =>
  renderComponent(
    <ConfirmDeleteDialog open onOpenChange={() => {}} title="Delete field “Gloss”" {...props}>
      <p>12 annotations.</p>
    </ConfirmDeleteDialog>,
  );

describe('ConfirmDeleteDialog', () => {
  it('draws the common look: triangle in the title, plain body, a red button with a short verb', async () => {
    const view = await mount();
    const box = dialog();
    const title = box.querySelector('h2');
    expect(title.textContent).toBe('Delete field “Gloss”');
    expect(title.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).not.toBe(
      null,
    );
    // No warning box around the body, and no trash icon anywhere.
    expect(box.querySelector('.border-destructive\\/50')).toBe(null);
    expect(box.querySelector('svg.lucide-trash-2, svg.lucide-trash2')).toBe(null);
    // The body is the dialog's description.
    const described = box.getAttribute('aria-describedby');
    expect(document.getElementById(described).textContent).toBe('12 annotations.');
    const confirm = button('Delete');
    expect(confirm.className).toContain('bg-destructive');
    await view.unmount();
  });

  it('waits on confirmDisabled, and disables both buttons while busy', async () => {
    const view = await mount({ confirmDisabled: true });
    expect(button('Delete').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
    await view.rerender(
      <ConfirmDeleteDialog open onOpenChange={() => {}} title="T" confirmLabel="Deleting…" busy>
        <p>x</p>
      </ConfirmDeleteDialog>,
    );
    expect(button('Deleting…').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    await view.unmount();
  });

  it('hands the click to onConfirm, which may keep the dialog open', async () => {
    const onConfirm = vi.fn((e) => e.preventDefault());
    const onOpenChange = vi.fn();
    const view = await renderComponent(
      <ConfirmDeleteDialog open onOpenChange={onOpenChange} title="T" onConfirm={onConfirm}>
        <p>x</p>
      </ConfirmDeleteDialog>,
    );
    await view.step(() => button('Delete').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    await view.unmount();
  });
});
