// Mounting a React component in a test, without a testing library.
//
// `plaid-igt` has no component-test dependency and adding one is a decision of
// its own, so this is the ~30 lines of it that the tests here actually need:
// mount into a detached container, flush effects through `act`, and read the
// result off the DOM. Porting to @testing-library/react later is mechanical,
// since these are the same primitives it wraps.
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/** Mount `element` and return the container plus helpers to drive it. */
export async function renderComponent(element) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    /** Run something that updates state, then let React settle. */
    async step(fn) {
      await act(async () => {
        await fn();
      });
    },
    /** Render a new element into the same root (new props, same instances). */
    async rerender(next) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Every element matching `selector`, as an array. */
export const all = (root, selector) => [...root.querySelectorAll(selector)];

/** The trimmed text of each element matching `selector`. */
export const texts = (root, selector) =>
  all(root, selector).map((n) => n.textContent.replace(/\s+/g, ' ').trim());

/** The first element whose text contains `needle`. */
export const byText = (root, selector, needle) =>
  all(root, selector).find((n) => n.textContent.includes(needle)) ?? null;
