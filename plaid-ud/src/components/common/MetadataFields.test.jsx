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

  it('adds nothing when Escape cancels a new field name', async () => {
    // The same shape as the value field above, in the sibling that had no
    // guard: Escape blurs, and the blur read the name still in state.
    const { container, step, unmount } = await renderComponent(
      <MetadataFields
        rows={ROWS}
        values={{ genre: 'fiction' }}
        onCommit={vi.fn()}
        validateName={() => null}
      />,
    );
    const before = all(container, 'input').length;
    const button = all(container, 'button').find((b) => b.textContent.includes('Add field'));
    await step(async () => button.click());

    const input = all(container, 'input').find(
      (i) => i.getAttribute('aria-label') === 'New field name',
    );
    await step(async () => type(input, 'speaker'));
    // This box autofocuses, so Escape's own blur() fires the real focusout.
    // Dispatching a second one by hand would submit twice, which the app never
    // does and which no guard here should have to absorb.
    await step(async () => press(input, 'Escape'));

    expect(all(container, 'input').length).toBe(before);
    expect(container.textContent).not.toContain('speaker');
    await unmount();
  });
});
