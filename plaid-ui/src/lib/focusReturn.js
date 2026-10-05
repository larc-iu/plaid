// Where focus goes back to when a dialog closes.
//
// Radix sends focus back to a dialog's Trigger, and almost every dialog in the
// apps is opened by a plain button, a menu item or a key with `open` held in
// state, so there is no Trigger and focus fell to the page's body: a keyboard
// user who pressed Escape had to Tab in again from the top of the page.
//
// So the page keeps a short list of what had focus, and a dialog notes that list
// as it opens. When it closes, focus goes back to the newest element in it that
// is still on the page. One that was removed (a menu item, the menu gone) is
// passed over for the one before it (the menu's button). A gap, where focus went
// to the body (a click on the page), or a different page (the dialog navigated),
// ends the search, and focus is left where Radix puts it.

import { useCallback, useRef } from 'react';

const KEEP = 8;
const recent = [];
let listening = false;

const here = () => (typeof window === 'undefined' ? '' : window.location.href);

const note = (entry) => {
  recent.push(entry);
  if (recent.length > KEEP) recent.shift();
};

function listen() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener(
    'focusin',
    (event) => {
      const el = event.target;
      if (el && el !== document.body && typeof el.focus === 'function') {
        note({ el, href: here() });
      }
    },
    true,
  );
  // Focus left for nothing (a click on the page's background) is a gap. Asked
  // once the move is over, since focus moving between two fields can report
  // no relatedTarget too.
  document.addEventListener(
    'focusout',
    () => {
      setTimeout(() => {
        const at = document.activeElement;
        if (!at || at === document.body) note(null);
      }, 0);
    },
    true,
  );
}

listen();

/**
 * The element that had focus last, even one since removed (a tab of a strip
 * that a route change drew afresh), or null.
 */
export function lastFocusedElement() {
  for (let i = recent.length - 1; i >= 0; i -= 1) if (recent[i]) return recent[i].el;
  return null;
}

/** What had focus, newest last, as the dialog opens. */
const focusSnapshot = () => recent.slice();

/**
 * The element to send focus back to from `snapshot`, or null. `content` is the
 * dialog itself, whose own fields are never the answer.
 */
function focusReturnTarget(snapshot, content) {
  const href = here();
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    const entry = snapshot[i];
    if (!entry || entry.href !== href) return null;
    const { el } = entry;
    if (content && content.contains(el)) continue;
    if (!el.isConnected) continue;
    return el;
  }
  return null;
}

/**
 * For a dialog's content: a ref that notes what had focus as the content
 * mounts, and the handler for Radix's `onCloseAutoFocus`. The note is taken in
 * the ref, not in `onOpenAutoFocus`, because Radix skips that event when a
 * field inside has already taken focus (`autoFocus`). A Trigger, when the
 * dialog has one, is left to Radix.
 */
export function useFocusReturn(forwardedRef) {
  const saved = useRef(null);
  const ref = useCallback(
    (node) => {
      if (node) saved.current = focusSnapshot();
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  const onClose = (event) => {
    const content = event.target;
    const id = content?.id;
    if (id && document.querySelector(`[aria-controls="${CSS.escape(id)}"]`)) return;
    const target = focusReturnTarget(saved.current ?? [], content);
    saved.current = null;
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
  return { ref, onClose };
}
