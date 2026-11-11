// Scrolling a floating box that is open over a modal dialog.
//
// A modal Dialog locks scrolling everywhere outside its own content: its lock
// (react-remove-scroll, inside Radix) listens for `wheel` and `touchmove` on the
// document and cancels any that started outside the dialog. A popover's
// content, and a combobox's list, are portalled to <body>, so they are outside
// it, and a wheel or a swipe over one was cancelled: only its scroll bar moved
// it. Stopping the two events at the box keeps them from the document, and the
// box scrolls natively. Nothing behind it moves: the box is not inside the
// dialog, and the lock has hidden the page's overflow.
//
// A Select and a DropdownMenu need none of this: they are modal and hold a lock
// of their own, which takes over from the dialog's while they are open.

const stop = (handler) => (event) => {
  handler?.(event);
  event.stopPropagation();
};

/** `onWheel` and `onTouchMove` for a portalled box, wrapping the caller's own. */
export const scrollThroughLock = ({ onWheel, onTouchMove } = {}) => ({
  onWheel: stop(onWheel),
  onTouchMove: stop(onTouchMove),
});
