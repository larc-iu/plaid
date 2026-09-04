// DOM glue for the backslash composer (domain/compose.js). Framework-free: the
// lit island and the React shells both bind through here so a code behaves the
// same in a grid cell and in a dialog.
//
// WHY `beforeinput` AND NOT `keydown`:
//  - Layout independence. `\` is AltGr+ß on German Windows, AltGr+8 on French,
//    Shift+Option+7 on German macOS. Windows delivers AltGr as Ctrl+Alt, so a
//    keydown handler guarded the way the grid's split is (`!e.ctrlKey &&
//    !e.metaKey`) would never see those users type a backslash at all. Android
//    Chrome reports `e.key` as `Unidentified`. `beforeinput` carries the
//    character in `e.data` regardless.
//  - IME safety for free. Composition arrives as `insertCompositionText`, never
//    as `insertText`, so a code can never fire mid-composition and the island's
//    keyCode-229 guard does not have to be duplicated on the React side.
//  - Paste is excluded by construction. Pasted text is `insertFromPaste`, so a
//    Toolbox record full of `\tx` and `\mb` markers drops in untouched.
//
// Only `insertText` of exactly one character composes. Dictation and autofill
// arrive as longer `insertText` payloads and are left alone.

import { composeInsert, composePending } from '@/domain/compose.js';
import { BUILT_IN_TABLE, resolveComposeTable } from '@/domain/composeConfig.js';

// The table in force right now. A project can bind codes of its own on top of
// the built-in ones, and the fields that compose are spread across the app, so
// the active project's table is parked here rather than threaded through every
// one of them. There is one open project at a time, and `setComposeProject` is
// called wherever a project is loaded or refreshed.
let activeTable = BUILT_IN_TABLE;

/** Point the composer at this project's codes. Pass null to go back to the built-ins. */
export const setComposeProject = (project) => {
  activeTable = project ? resolveComposeTable(project.config) : BUILT_IN_TABLE;
};

/** The table in force, for callers that need to look a code up themselves. */
export const activeComposeTable = () => activeTable;

// Which backslash in this field is a literal the user escaped. Element state,
// not a WeakMap keyed by value, because the island reuses inputs across
// renders and lit will not repaint what it thinks is unchanged.
const ESCAPED = '__igtComposeEscapedAt';

const escapedAtOf = (el) => {
  const i = el[ESCAPED];
  // A stale index: the field changed under us and that backslash is gone.
  if (typeof i !== 'number' || el.value?.[i] !== '\\') return -1;
  return i;
};

/** Forget any escape state, e.g. when a field is re-seeded programmatically. */
export const clearComposeState = (el) => {
  if (el) delete el[ESCAPED];
};

/**
 * Is a code open in front of the caret in this field? The morpheme grid asks
 * before treating `-` or `=` as a split boundary: 22 codes end in one of those
 * and 18 begin with one, so the split has to stand down mid-code.
 */
export const composePendingOn = (el) => {
  if (!el || typeof el.value !== 'string') return false;
  const caret = el.selectionStart;
  if (caret == null || caret !== el.selectionEnd) return false;
  return composePending(el.value, caret, { escapedAt: escapedAtOf(el) });
};

// Replace [start, end) with `text`, keeping the browser's undo stack intact.
// execCommand is deprecated but is still the only programmatic insert that
// undo can see, and it fires a native `input` event, which is what keeps React's
// controlled inputs in step. The fallback covers happy-dom in tests.
const replaceRange = (el, start, end, text) => {
  el.setSelectionRange(start, end);
  try {
    if (typeof document !== 'undefined' && document.execCommand?.('insertText', false, text)) {
      return;
    }
  } catch {
    /* fall through */
  }
  const proto =
    typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  if (setter) setter.call(el, next);
  else el.value = next;
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/**
 * The `beforeinput` handler. Returns true when it consumed the event, so a
 * caller that wants to know can branch on it.
 */
export function handleComposeBeforeInput(e) {
  const el = e.target;
  if (!el || typeof el.value !== 'string') return false;
  if (e.inputType !== 'insertText') return false;
  const ch = e.data;
  if (typeof ch !== 'string' || ch.length !== 1) return false;
  const caret = el.selectionStart;
  // With a range selected the typed character replaces it, so nothing can be
  // pending in front of it.
  if (caret == null || caret !== el.selectionEnd) return false;

  const r = composeInsert(el.value, caret, ch, { escapedAt: escapedAtOf(el), table: activeTable });
  if (!r) return false;

  e.preventDefault();
  replaceRange(el, r.start, r.end, r.text);
  if (r.escapedAt == null) clearComposeState(el);
  else el[ESCAPED] = r.escapedAt;
  return true;
}

/** Bind an input or textarea. Returns a detach function. */
export function attachCompose(el) {
  if (!el) return () => {};
  el.addEventListener('beforeinput', handleComposeBeforeInput);
  return () => {
    el.removeEventListener('beforeinput', handleComposeBeforeInput);
    clearComposeState(el);
  };
}
