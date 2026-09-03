import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderComponent, all } from '../../../test/renderComponent.jsx';
import { TimecodeField } from './TimecodeField.jsx';

// The segmented duration control on its own: digits, completion, movement
// between boxes, the hours box, and the carry of a nudge across boxes.

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const press = (el, key, init = {}) => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};
const box = (root, unit) => root.querySelector(`input[aria-label="Time ${unit}"]`);
const shown = (root) => root.querySelector('[role="group"]').dataset.value;

describe('TimecodeField', () => {
  it('shows minutes, seconds and milliseconds as boxes, hours only for a long recording', async () => {
    const r = await renderComponent(
      <TimecodeField value={65.25} label="Time" onCommit={vi.fn()} />,
    );
    expect(all(r.container, 'input').map((i) => i.value)).toEqual(['1', '05', '250']);
    expect(shown(r.container)).toBe('1:05.250');
    await r.unmount();

    const long = await renderComponent(
      <TimecodeField value={3725.25} label="Time" duration={7200} onCommit={vi.fn()} />,
    );
    expect(all(long.container, 'input').map((i) => i.value)).toEqual(['01', '02', '05', '250']);
    expect(shown(long.container)).toBe('1:02:05.250');
    await long.unmount();
  });

  it('a digit that no further digit could extend completes the box and moves on', async () => {
    const r = await renderComponent(<TimecodeField value={0} label="Time" onCommit={vi.fn()} />);
    const s = box(r.container, 'seconds');
    await r.step(() => s.focus());
    await r.step(() => setValue(s, '7')); // seconds cannot be 7x, so this is 07
    expect(s.value).toBe('07');
    expect(document.activeElement).toBe(box(r.container, 'milliseconds'));
    await r.step(() => setValue(box(r.container, 'milliseconds'), '5'));
    expect(shown(r.container)).toBe('0:07.005'); // a partial box counts as typed so far
    await r.unmount();
  });

  it('Left and Right move between boxes, Enter saves what the boxes say', async () => {
    const onCommit = vi.fn(async () => true);
    const r = await renderComponent(<TimecodeField value={3} label="Time" onCommit={onCommit} />);
    const s = box(r.container, 'seconds');
    await r.step(() => s.focus());
    await r.step(() => press(s, 'ArrowRight'));
    expect(document.activeElement).toBe(box(r.container, 'milliseconds'));
    await r.step(() => press(box(r.container, 'milliseconds'), 'ArrowLeft'));
    expect(document.activeElement).toBe(s);
    await r.step(() => setValue(s, '12'));
    await r.step(async () => {
      press(box(r.container, 'milliseconds'), 'Enter');
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(onCommit).toHaveBeenCalledWith(12);
    await r.unmount();
  });

  it('a nudge carries across boxes and never goes below zero', async () => {
    const r = await renderComponent(
      <TimecodeField value={3.995} label="Time" onCommit={vi.fn()} />,
    );
    const ms = box(r.container, 'milliseconds');
    await r.step(() => ms.focus());
    await r.step(() => press(ms, 'ArrowUp'));
    expect(shown(r.container)).toBe('0:04.005');
    await r.step(() => press(box(r.container, 'seconds'), 'ArrowDown', { shiftKey: true }));
    expect(shown(r.container)).toBe('0:00.000');
    await r.unmount();
  });

  it('a refused save puts the boxes back', async () => {
    const onCommit = vi.fn(async () => false);
    const r = await renderComponent(<TimecodeField value={3} label="Time" onCommit={onCommit} />);
    const s = box(r.container, 'seconds');
    await r.step(() => s.focus());
    await r.step(() => setValue(s, '09'));
    await r.step(async () => {
      press(s, 'Enter');
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(onCommit).toHaveBeenCalledWith(9);
    expect(shown(r.container)).toBe('0:03.000');
    await r.unmount();
  });
});
