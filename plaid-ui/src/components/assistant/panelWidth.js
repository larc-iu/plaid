// How wide the docked assistant is, and where that is remembered.

import { appPrefix } from '../../lib/uiConfig.js';

// Per app, like every other key in this package. In the jar `/ud/` and `/igt/`
// are one origin, so a shared name meant dragging the panel in one app resized
// it in the other. Lazy, because `appPrefix` throws before `configureUi` runs
// and this module is imported at load.
const widthKey = () => `${appPrefix()}_assistant_panel_width`;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;
export const DEFAULT_WIDTH = 400;

// Math.max/min pass NaN straight through, and a NaN width paints nothing at
// all, so anything that is not a real number falls back to the default.
export const clampWidth = (w) =>
  Number.isFinite(w) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w))) : DEFAULT_WIDTH;

export const readWidth = () => {
  try {
    const stored = Number(localStorage.getItem(widthKey()));
    return stored ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    // A browser that refuses storage still resizes, it just forgets.
    return DEFAULT_WIDTH;
  }
};

export const saveWidth = (w) => {
  try {
    localStorage.setItem(widthKey(), String(w));
  } catch {
    // See readWidth.
  }
};
