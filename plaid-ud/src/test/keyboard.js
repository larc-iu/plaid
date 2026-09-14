// Driving a text input from a component test the way a keyboard drives it.
//
// The annotation grid's three inputs (EditableCell, FeaturesCell and the tree's
// DeprelEditor) each answer the same questions about typing, arriving and
// leaving, so they ask them the same way.
//
// `type` writes ONE CHARACTER AT A TIME through the native value setter. React
// tracks the value it last saw and suppresses an onChange that matches it, so
// assigning a whole word at once reports only the last character, and re-typing
// a value over itself reports nothing at all, which is exactly the case these
// cells answer their provenance question with.
//
// `focus` and `blur` dispatch focusin / focusout rather than focus / blur,
// because React's onFocus and onBlur listen for the bubbling pair.

/** Type `text` into `input`, a character at a time. */
export const type = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  for (let i = 1; i <= text.length; i++) {
    setter.call(input, text.slice(0, i));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

/** Arrive in `input`. */
export const focus = (input) => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

/** Leave `input`. */
export const blur = (input) => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

/** Press `key` in `input`. `init` carries the modifiers, e.g. `{ ctrlKey: true }`. */
export const press = (input, key, init) =>
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
