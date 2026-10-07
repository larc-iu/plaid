// What Text mode's status line says before Apply (the owner's rulings of
// 2026-09-28): every concept change by variable, and an emptied text is a
// deletion Apply can make, with the usual line naming what goes.
import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('@ui/components/shared/ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { PenmanEditor } = await import('./PenmanEditor.jsx');

const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const INITIAL = '(s9y / sleep-01\n    :ARG0 (s9x / cat))';

const render = (plan) =>
  renderComponent(
    <PenmanEditor initial={INITIAL} onApply={() => {}} onCancel={() => {}} plan={plan} />,
  );

const status = (view) => view.container.querySelector('.umr-penman-status').textContent;
const apply = (view) =>
  [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Apply');

describe('the status line', () => {
  it('is a status region, so a screen reader hears a refusal or a change', async () => {
    const view = await render(() => ({ rename: [], losses: [], concept: [] }));
    const line = view.container.querySelector('.umr-penman-status');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe('As stored.');
    view.unmount?.();
  });

  it('names every concept change, a swap included', async () => {
    const view = await render(() => ({
      rename: [],
      losses: [],
      concept: [
        { var: 's9x', from: 'cat', concept: 'sleep-01' },
        { var: 's9y', from: 'sleep-01', concept: 'cat' },
      ],
    }));
    await view.step(() =>
      type(view.container.querySelector('textarea'), '(s9x / sleep-01\n    :ARG0 (s9y / cat))'),
    );
    expect(status(view)).toBe(
      'Changed. Click Apply to save it. s9x changes from cat to sleep-01, s9y from sleep-01 to cat.',
    );
    view.unmount?.();
  });

  it('lets an emptied text through, saying what Apply deletes', async () => {
    const view = await render((text) => {
      expect(text).toBe('');
      return {
        rename: [],
        concept: [],
        losses: [
          { var: 's9y', anchored: true, relations: 2 },
          { var: 's9x', anchored: true, relations: 0 },
        ],
      };
    });
    await view.step(() => type(view.container.querySelector('textarea'), ''));
    expect(status(view)).toBe(
      'Changed. Click Apply to save it. It deletes s9y with its anchor and 2 document-level relations, s9x with its anchor.',
    );
    expect(apply(view).disabled).toBe(false);
    view.unmount?.();
  });
});
