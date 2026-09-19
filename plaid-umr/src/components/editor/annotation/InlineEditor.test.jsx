import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { InlineEditor } from './InlineEditor.jsx';

const options = [
  { group: 'Senses', items: [{ value: 'lunch-01', label: 'lunch-01 ARG1 food' }] },
  { group: 'Word', items: ['lunch'] },
];

const press = (input, key) =>
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const type = (r, input, text) =>
  r.step(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

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
    expect(onCommit).toHaveBeenCalledWith('lunch', null);
    await r.unmount();
  });

  // Typed text is what Enter writes: an option whose label merely holds it is
  // shown, not taken. `lunch-` was finished as `lunch-01`, and `place` under
  // escape-01 as :ARG1, whose label reads "place or thing escaped".
  it('commits what was typed, not an option whose label holds it', async () => {
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
    await type(r, input, 'food');
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith('food', null);
    await r.unmount();
  });

  it('commits an option whose value is exactly what was typed', async () => {
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
    await type(r, input, 'lunch-01');
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith(
      'lunch-01',
      expect.objectContaining({ value: 'lunch-01' }),
    );
    await r.unmount();
  });

  it('commits the option the arrows moved to', async () => {
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
    await type(r, input, 'lunch-');
    await r.step(() => press(input, 'ArrowDown'));
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith(
      'lunch-01',
      expect.objectContaining({ value: 'lunch-01' }),
    );
    await r.unmount();
  });

  // Relations are a closed list: a value's beginning finishes it, the colon
  // optional, and a label still never does.
  it('completes a relation from its value, never from its label', async () => {
    const roles = [
      {
        group: 'escape-01',
        items: [
          { value: ':ARG0', label: ':ARG0 escaper' },
          { value: ':ARG1', label: ':ARG1 place or thing escaped' },
        ],
      },
      { group: 'Non-core', items: [':place', ':purpose'] },
    ];
    const run = async (typed) => {
      const onCommit = vi.fn();
      const r = await renderComponent(
        <InlineEditor
          x={0}
          y={0}
          value=""
          options={roles}
          complete
          onCommit={onCommit}
          onCancel={() => {}}
        />,
      );
      const input = r.container.querySelector('input');
      await type(r, input, typed);
      await r.step(() => press(input, 'Enter'));
      await r.unmount();
      return onCommit.mock.calls[0][0];
    };
    expect(await run('place')).toBe(':place');
    expect(await run('ARG')).toBe(':ARG0');
    expect(await run(':purp')).toBe(':purpose');
  });

  // A refused value keeps the editor open with the reason under it, so what
  // was typed is there to correct, and the corrected value commits.
  it('stays open with the reason when the value is refused', async () => {
    const onCommit = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value="s1l2"
        onCommit={onCommit}
        onCancel={() => {}}
        check={(text) => (text === 's1p' ? 's1p is already in use.' : null)}
      />,
    );
    const input = r.container.querySelector('input');
    await type(r, input, 's1p');
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).not.toHaveBeenCalled();
    expect(r.container.querySelector('[role="alert"]').textContent).toBe('s1p is already in use.');
    expect(input.value).toBe('s1p');
    await type(r, input, 's1lu');
    expect(r.container.querySelector('[role="alert"]')).toBe(null);
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith('s1lu', null);
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
