// The three looks a delete or a clear takes, the same in every app. Tailwind
// classes, written out whole so the class scanner finds them in this file.
//
// 1. A row's trash icon: a ghost icon button, grey at rest and red on hover.
// 2. A labelled delete or clear at rest: an outline button with red text.
// 3. Solid red: only the final button inside the confirm.
//
// Nothing that only OPENS a confirm is solid red. A solid red button on a
// settings page is the loudest thing there, and the confirm behind it says the
// same again.

/** Tier 1, over `variant="ghost" size="icon"`: a row's trash icon. */
export const ROW_DELETE_CLASS = 'text-muted-foreground hover:text-destructive';

/** Tier 2, over `variant="outline"`: a labelled delete or clear at rest. */
export const DELETE_BUTTON_CLASS = 'text-destructive hover:bg-destructive/5 hover:text-destructive';

/** Tier 3: the confirm's own button, where the variant cannot be set. */
export const CONFIRM_DELETE_CLASS =
  'bg-destructive text-destructive-foreground hover:bg-destructive/90';
