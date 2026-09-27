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

  // Leaving the editor writes what Enter writes. `arg2` and a click away left
  // the role as it was, because the blur checked the raw text, which the
  // check refuses, while Enter finished it as :ARG2 first.
  it('commits on blur what Enter commits: a relation finished from its value', async () => {
    const roles = [{ group: 'Core', items: [':ARG0', ':ARG1', ':ARG2'] }];
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value=":ARG1"
        options={roles}
        complete
        onCommit={onCommit}
        onCancel={onCancel}
        check={(text) => (/^:[A-Za-z]/.test(text) && text !== ':arg2' ? null : 'Unknown relation.')}
      />,
    );
    const input = r.container.querySelector('input');
    await type(r, input, 'arg2');
    await r.step(() => input.blur());
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith(':ARG2', expect.objectContaining({ value: ':ARG2' }));
    await r.unmount();
  });

  // A blur on a value Enter would refuse drops nothing silently: the editor
  // stays with the reason, and what was typed is there to correct.
  it('stays open with the reason when a blur leaves a refused value', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value="s1l2"
        onCommit={onCommit}
        onCancel={onCancel}
        check={(text) => (text === 's1p' ? 's1p is already in use.' : null)}
      />,
    );
    const input = r.container.querySelector('input');
    await type(r, input, 's1p');
    await r.step(() => input.blur());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(r.container.querySelector('[role="alert"]').textContent).toBe('s1p is already in use.');
    expect(input.value).toBe('s1p');
    await r.step(() => input.focus());
    await type(r, input, 's1lu');
    await r.step(() => press(input, 'Enter'));
    expect(onCommit).toHaveBeenCalledWith('s1lu', null);
    expect(onCommit).toHaveBeenCalledTimes(1);
    await r.unmount();
  });

  // The canvas answers no key while an editor is open, so a refused blur
  // that left focus on the page left the keyboard nothing to press.
  it('takes focus back after a refused blur to the page, and Escape closes it', async () => {
    const onCancel = vi.fn();
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value=""
        onCommit={() => {}}
        onCancel={onCancel}
        check={() => "Unknown relation ':zzqq'."}
      />,
    );
    const input = r.container.querySelector('input');
    await type(r, input, 'zzqq');
    await r.step(() => input.blur());
    await r.step(() => new Promise((done) => setTimeout(done, 10)));
    expect(document.activeElement).toBe(input);
    await r.step(() => press(input, 'Escape'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await r.unmount();
  });

  it('closes on Escape after a refused blur to another field', async () => {
    const onCancel = vi.fn();
    const field = document.createElement('input');
    document.body.appendChild(field);
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value=""
        onCommit={() => {}}
        onCancel={onCancel}
        check={() => "Unknown relation ':zzqq'."}
      />,
    );
    const input = r.container.querySelector('input');
    await type(r, input, 'zzqq');
    await r.step(() => field.focus());
    await r.step(() => new Promise((done) => setTimeout(done, 10)));
    expect(document.activeElement).toBe(field);
    expect(onCancel).not.toHaveBeenCalled();
    await r.step(() => press(document.body, 'Escape'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await r.unmount();
    field.remove();
  });

  // A menu or dialog opened by that click traps focus, and pulling it back to
  // the input would fight the trap and leave the menu dead.
  it.each([['menu'], ['dialog'], ['listbox']])(
    'leaves focus in a %s after a refused blur, and Escape there still closes the editor',
    async (role) => {
      const onCancel = vi.fn();
      const popup = document.createElement('div');
      popup.setAttribute('role', role);
      const item = document.createElement('div');
      item.tabIndex = -1;
      item.textContent = 'Delete';
      popup.appendChild(item);
      document.body.appendChild(popup);
      const r = await renderComponent(
        <InlineEditor
          x={0}
          y={0}
          value=""
          onCommit={() => {}}
          onCancel={onCancel}
          check={() => "Unknown relation ':zzqq'."}
        />,
      );
      const input = r.container.querySelector('input');
      await type(r, input, 'zzqq');
      await r.step(() => item.focus());
      await r.step(() => new Promise((done) => setTimeout(done, 10)));
      expect(document.activeElement).toBe(item);
      expect(onCancel).not.toHaveBeenCalled();
      await r.step(() => press(item, 'Escape'));
      expect(onCancel).toHaveBeenCalledTimes(1);
      await r.unmount();
      popup.remove();
    },
  );

  it('takes focus back after a refused blur to a plain button on the page', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value=""
        onCommit={() => {}}
        onCancel={() => {}}
        check={() => "Unknown relation ':zzqq'."}
      />,
    );
    const input = r.container.querySelector('input');
    await type(r, input, 'zzqq');
    await r.step(() => button.focus());
    await r.step(() => new Promise((done) => setTimeout(done, 10)));
    expect(document.activeElement).toBe(input);
    await r.unmount();
    button.remove();
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

  // Chromium's select() focuses the input, so a deferred select-on-arrival that
  // fires after the caret has left pulls it back from wherever it went.
  it('never selects the value once the caret has left it', async () => {
    const r = await renderComponent(
      <InlineEditor
        x={0}
        y={0}
        value="lunch"
        options={options}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const input = r.container.querySelector('input');
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    // The editor takes the caret when it opens, so leave it first and come back.
    elsewhere.focus();
    const select = vi.spyOn(input, 'select');

    await r.step(() => {
      input.focus();
      elsewhere.focus();
    });
    await r.step(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(document.activeElement).toBe(elsewhere);
    expect(select).not.toHaveBeenCalled();
    elsewhere.remove();
    await r.unmount();
  });
});
