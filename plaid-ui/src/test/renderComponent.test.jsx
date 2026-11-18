import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { useState } from 'react';
import { renderComponent } from './renderComponent.jsx';

// What React prints to console.error while this file runs.
const printed = [];
let spy;
beforeAll(() => {
  spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args) => printed.push(args.map(String).join(' ')));
});
afterAll(() => spy.mockRestore());

function Counter({ label }) {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      {label} {n}
    </button>
  );
}

describe('renderComponent after a test that timed out inside a step', () => {
  // The step outlives the test's 50 ms bound, and its next step starts after
  // the test has already failed.
  it.fails(
    'times out inside a step',
    async () => {
      const view = await renderComponent(<Counter label="first" />);
      await view.step(() => new Promise((resolve) => setTimeout(resolve, 200)));
      await view.step(() => view.container.querySelector('button').click());
    },
    50,
  );

  it('the next test renders, and no act() warning is printed', async () => {
    const view = await renderComponent(<Counter label="next" />);
    expect(view.container.textContent).toBe('next 0');
    await view.step(() => view.container.querySelector('button').click());
    expect(view.container.textContent).toBe('next 1');
    expect(document.body.textContent).not.toContain('first');
    expect(printed.filter((line) => line.includes('act('))).toEqual([]);
    await view.unmount();
  });
});
