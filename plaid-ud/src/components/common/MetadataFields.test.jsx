import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { MetadataFields } from './MetadataFields.jsx';

// Each field is its own write, committed on blur or Enter, so the only way to
// take a typed value back is Escape. Escape blurs the input, and that blur
// runs synchronously inside the key handler with the typed text still in
// state, so without a guard the cancel saved exactly what it was cancelling.

const ROWS = [{ name: 'genre', declared: true }];

const mount = (onCommit) =>
  renderComponent(<MetadataFields rows={ROWS} values={{ genre: 'fiction' }} onCommit={onCommit} />);

const type = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const press = (input, key) =>
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('MetadataFields', () => {
  it('commits a typed value on blur', async () => {
    const onCommit = vi.fn();
    const { container, step, unmount } = await mount(onCommit);
    const input = all(container, 'input')[0];

    await step(async () => type(input, 'poetry'));
    await step(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

    expect(onCommit).toHaveBeenCalledWith('genre', 'poetry');
    await unmount();
  });

  it('writes nothing when Escape cancels the edit', async () => {
    const onCommit = vi.fn();
    const { container, step, unmount } = await mount(onCommit);
    const input = all(container, 'input')[0];

    await step(async () => type(input, 'poetry'));
    await step(async () => {
      press(input, 'Escape');
      // The blur Escape asks for, which is what used to do the saving.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('fiction');
    await unmount();
  });
});
