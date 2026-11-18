// Mounting a React component in a test, without a testing library.
//
// `plaid-igt` has no component-test dependency and adding one is a decision of
// its own, so this is the ~30 lines of it that the tests here actually need:
// mount into a detached container, flush effects through `act`, and read the
// result off the DOM. Porting to @testing-library/react later is mechanical,
// since these are the same primitives it wraps.
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// Every view still mounted, and every act() still running. A test that fails
// or times out before its own unmount would otherwise leave its component in
// document.body (a modal dialog holding focus and aria-hidden, rows a later
// query reads). One that times out inside a step goes on running, and React
// takes the next test's renders into that still-open act(), where they never
// commit. Either way every later test in the file would fail.
const mounted = new Set();
const running = new Set();

async function inAct(fn) {
  const done = act(fn);
  running.add(done);
  try {
    await done;
  } finally {
    running.delete(done);
  }
}

async function unmountView(view) {
  if (!mounted.delete(view)) return;
  await inAct(async () => {
    view.root.unmount();
  });
  view.container.remove();
}

// As @testing-library/react does: after each test of any file that mounts
// through here, let a step still running finish, then unmount what the test
// left. `afterEach` is a global (the apps' vitest configs set `globals: true`).
if (typeof globalThis.afterEach === 'function') {
  globalThis.afterEach(async () => {
    while (running.size) await Promise.allSettled([...running]);
    for (const view of [...mounted]) await unmountView(view);
  });
}

/** Mount `element` and return the container plus helpers to drive it. */
export async function renderComponent(element) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const live = { root, container };
  mounted.add(live);
  await inAct(async () => {
    root.render(element);
  });
  return {
    container,
    /** Run something that updates state, then let React settle. */
    async step(fn) {
      await inAct(async () => {
        await fn();
      });
    },
    /** Render a new element into the same root (new props, same instances). */
    async rerender(next) {
      await inAct(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await unmountView(live);
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
