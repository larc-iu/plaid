import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderComponent } from '../../../test/renderComponent.jsx';
import { useThrottledValue } from './useThrottledValue.js';

function Clock({ value, bypass }) {
  const shown = useThrottledValue(value, 200, { bypass });
  return <output>{shown}</output>;
}

const shown = (r) => r.container.querySelector('output').textContent;

describe('useThrottledValue', () => {
  afterEach(() => vi.useRealTimers());

  it('republishes at most once per interval and always ends on the latest value', async () => {
    vi.useFakeTimers();
    const r = await renderComponent(<Clock value={0} />);
    expect(shown(r)).toBe('0');
    // A burst inside one interval: the display holds, then flushes the last.
    for (const v of [1, 2, 3]) {
      await r.rerender(<Clock value={v} />);
      expect(shown(r)).toBe('0');
    }
    await r.step(() => vi.advanceTimersByTime(200));
    expect(shown(r)).toBe('3');
    // The next change after a full interval shows at once.
    await r.step(() => vi.advanceTimersByTime(200));
    await r.rerender(<Clock value={4} />);
    expect(shown(r)).toBe('4');
    await r.unmount();
  });

  it('passes the value straight through while bypassed, so a paused clock is exact', async () => {
    vi.useFakeTimers();
    const r = await renderComponent(<Clock value={0} bypass />);
    await r.rerender(<Clock value={7} bypass />);
    expect(shown(r)).toBe('7');
    await r.rerender(<Clock value={8} bypass />);
    expect(shown(r)).toBe('8');
    await r.unmount();
  });
});
