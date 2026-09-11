import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Combobox, normalizeOptions, flattenOptions, defaultFilter } from './combobox.jsx';

describe('the option shapes', () => {
  it('takes strings, objects and groups in one list', () => {
    expect(
      normalizeOptions(['a', { value: 'b', label: 'Bee' }, { group: 'G', items: ['c'] }]),
    ).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'Bee' },
      { group: 'G', items: [{ value: 'c', label: 'c' }] },
    ]);
  });

  it('walks a grouped list in display order', () => {
    const options = normalizeOptions([{ group: 'G', items: ['a', 'b'] }, 'c']);
    expect(flattenOptions(options).map((o) => o.value)).toEqual(['a', 'b', 'c']);
  });

  it('drops a group the search emptied', () => {
    const options = normalizeOptions([
      { group: 'Parser suggestions', items: ['NOUN'] },
      { group: 'All tags', items: ['VERB', 'ADV'] },
    ]);
    expect(defaultFilter({ options, search: 'ver' })).toEqual([
      { group: 'All tags', items: [{ value: 'VERB', label: 'VERB' }] },
    ]);
  });
});

// The contract the annotation grid depends on: the call site is told what the
// list is doing before it decides what a key means, and preventDefault means it
// took the key.
describe('Combobox keyboard state', () => {
  const TAGS = ['NOUN', 'VERB', 'ADV'];

  const Harness = ({ onKeyDown, onSubmit, autoHighlight = false, options = TAGS }) => {
    const [value, setValue] = useState('');
    return (
      <Combobox
        value={value}
        onChange={setValue}
        options={options}
        autoHighlight={autoHighlight}
        onKeyDown={onKeyDown}
        onSubmit={onSubmit}
      />
    );
  };

  const mount = async (props) => {
    const view = await renderComponent(<Harness {...props} />);
    const input = view.container.querySelector('input');
    const press = (key, init = {}) =>
      view.step(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
        );
      });
    const focus = () => view.step(() => input.focus());
    return { ...view, input, press, focus };
  };

  it('reports a closed list until the field is focused', async () => {
    const seen = [];
    const v = await mount({ onKeyDown: (_e, state) => seen.push(state.open) });
    await v.press('ArrowDown');
    await v.focus();
    await v.press('ArrowDown');
    expect(seen).toEqual([false, true]);
    await v.unmount();
  });

  it('highlights nothing until an arrow says so', async () => {
    const seen = [];
    const v = await mount({ onKeyDown: (_e, state) => seen.push(state.activeValue) });
    await v.focus();
    await v.press('ArrowDown'); // reports the state BEFORE it acts
    await v.press('ArrowDown');
    await v.press('ArrowUp');
    expect(seen).toEqual([null, 'NOUN', 'VERB']);
    await v.unmount();
  });

  it('wraps around the ends of the list', async () => {
    const seen = [];
    const v = await mount({ onKeyDown: (_e, state) => seen.push(state.activeValue) });
    await v.focus();
    await v.press('ArrowUp'); // opens at the bottom
    await v.press('ArrowDown');
    expect(seen).toEqual([null, 'ADV']);
    await v.unmount();
  });

  it('auto-highlights the first option when asked to', async () => {
    const seen = [];
    const v = await mount({
      autoHighlight: true,
      onKeyDown: (_e, state) => seen.push(state.activeValue),
    });
    await v.focus();
    await v.press('Enter');
    expect(seen).toEqual(['NOUN']);
    await v.unmount();
  });

  it('submits the highlighted option on Enter', async () => {
    const submitted = [];
    const v = await mount({ autoHighlight: true, onSubmit: (value) => submitted.push(value) });
    await v.focus();
    await v.press('Enter');
    expect(submitted).toEqual(['NOUN']);
    await v.unmount();
  });

  it('leaves a key alone once the call site has taken it', async () => {
    const submitted = [];
    const v = await mount({
      autoHighlight: true,
      onKeyDown: (event) => event.preventDefault(),
      onSubmit: (value) => submitted.push(value),
    });
    await v.focus();
    await v.press('Enter');
    await v.press('ArrowDown');
    expect(submitted).toEqual([]);
    await v.unmount();
  });

  it('forgets the highlight when the list changes underneath it', async () => {
    const seen = [];
    const onKeyDown = (_e, state) => seen.push(state.activeValue);
    const v = await mount({ onKeyDown });
    await v.focus();
    await v.press('ArrowDown');
    await v.press('ArrowDown'); // NOUN is highlighted
    await v.rerender(<Harness onKeyDown={onKeyDown} options={['VERB', 'ADV']} />);
    await v.press('Enter');
    expect(seen).toEqual([null, 'NOUN', null]);
    await v.unmount();
  });
});
