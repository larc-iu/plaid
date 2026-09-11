// How wide the docked assistant is, and where that is remembered.

const WIDTH_KEY = 'plaid.assistant.panel.width';
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;
export const DEFAULT_WIDTH = 400;

// Math.max/min pass NaN straight through, and a NaN width paints nothing at
// all, so anything that is not a real number falls back to the default.
export const clampWidth = (w) =>
  Number.isFinite(w) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w))) : DEFAULT_WIDTH;

export const readWidth = () => {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    // A browser that refuses storage still resizes, it just forgets.
    return DEFAULT_WIDTH;
  }
};

export const saveWidth = (w) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // See readWidth.
  }
};
