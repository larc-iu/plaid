import { describe, expect, it } from 'vitest';
import { useEffect, useState } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';
import { useEditLog } from './useEditLog.js';

let api = null;

function Box({ base, onApi }) {
  const [value, setValue] = useState(base);
  const log = useEditLog(base, 'd0');
  useEffect(() => {
    onApi(log);
  });
  return (
    <textarea
      value={value}
      {...log.handlers}
      onChange={(event) => {
        log.onChange(event);
        setValue(event.target.value);
      }}
    />
  );
}

// What a browser does for one input: the new value and caret, then `input`.
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
function input(el, value, caret, inputType = null, start = caret) {
  setValue.call(el, value);
  el.setSelectionRange(start, caret);
  el.dispatchEvent(
    inputType
      ? new InputEvent('input', { bubbles: true, inputType })
      : new Event('input', { bubbles: true }),
  );
}

describe('useEditLog', () => {
  it('logs a textarea’s changes from the selection it saw before each', async () => {
    const view = await renderComponent(<Box base="the cat sat" onApi={(next) => (api = next)} />);
    const el = view.container.querySelector('textarea');
    await view.step(() => {
      el.setSelectionRange(4, 7);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await view.step(() => input(el, 'the d sat', 5));
    await view.step(() => input(el, 'the do sat', 6));
    await view.step(() => input(el, 'the dog sat', 7));
    expect(api.log.body).toBe('the dog sat');
    expect(api.gaps()).toEqual([{ start: 4, end: 7, value: 'dog' }]);

    let sent;
    await view.step(() => {
      sent = api.send();
    });
    expect(sent).toEqual({
      base: 'the cat sat',
      digest: 'd0',
      gaps: [{ start: 4, end: 7, value: 'dog' }],
    });
    await view.step(() => input(el, 'the dogs sat', 8));
    expect(api.gaps()).toEqual([{ start: 7, end: 7, value: 's' }]);
    await view.step(() => api.settle('d1'));
    expect(api.log.digest).toBe('d1');

    await view.step(() => api.rebase('a dog sat', 'd2'));
    expect(api.log).toMatchObject({ base: 'a dog sat', digest: 'd2', body: 'a dogs sat' });
    let refused;
    await view.step(() => {
      refused = api.rebase('the cow sat', 'd3');
    });
    expect(refused).toEqual({ conflict: true });
    expect(api.log.base).toBe('a dog sat');

    await view.step(() => api.reset('new', 'd9'));
    expect(api.log).toEqual({ base: 'new', digest: 'd9', ops: [], raw: 'new', body: 'new' });
    await view.unmount();
  });

  it('reads an undo where Chrome put the text back, not at a selection left elsewhere (H1-IGT-TEXT-3)', async () => {
    const base = 'a\ndi ra\ndi ra\nend';
    const view = await renderComponent(<Box base={base} onApi={(next) => (api = next)} />);
    const el = view.container.querySelector('textarea');
    await view.step(() => {
      el.setSelectionRange(2, 8);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await view.step(() => input(el, 'a\ndi ra\nend', 2, 'deleteContentForward'));
    // the caret moves to the end, a selection is captured there, then Ctrl+Z
    await view.step(() => {
      el.setSelectionRange(11, 11);
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z' }));
    });
    await view.step(() => input(el, base, 8, 'historyUndo', 2));
    expect(api.log.body).toBe(base);
    expect(api.gaps()).toEqual([]);
    await view.unmount();
  });
});
