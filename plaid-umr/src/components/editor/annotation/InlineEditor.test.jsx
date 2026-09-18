import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { InlineEditor } from './InlineEditor.jsx';

const options = [
  { group: 'Senses', items: [{ value: 'lunch-01', label: 'lunch-01 ARG1 food' }] },
  { group: 'Word', items: ['lunch'] },
];

const press = (input, key) =>
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('InlineEditor', () => {
  it('commits the prefilled value on Enter when nothing was typed or highlighted', async () => {
    const onCommit = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value="lunch"
        options={options}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    const input = r.container.querySelector('input');
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith('lunch');
    await r.unmount();
  });

  it('commits the highlighted match once something was typed', async () => {
    const onCommit = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value=""
        options={options}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    const input = r.container.querySelector('input');
    await r.step(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'lunch-');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith('lunch-01');
    await r.unmount();
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value="x"
        options={options}
        onCommit={() => {}}
        onCancel={onCancel}
      />,
    );
    await r.step(() => press(r.container.querySelector('input'), 'Escape'));
    expect(onCancel).toHaveBeenCalled();
    await r.unmount();
  });
});
