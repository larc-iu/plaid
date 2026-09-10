import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn's class-name combiner: clsx for conditional classes + tailwind-merge to
// dedupe conflicting Tailwind utilities.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Portaled surfaces (dialogs, popovers, menus, toasts) mount at <body>, outside
// the app's own React tree, so they inherit nothing an app wraps its screens in.
//
// plaid-ud is mid-migration from Mantine and its Tailwind preflight is SCOPED to
// `.tw` subtrees rather than global, because a global reset would clobber the
// Mantine half (plaid-ud/src/index.css). A portaled root that does not carry the
// class therefore renders with no box-sizing and, worse, no border-style, which
// makes every `border` utility on it paint nothing at all.
//
// So every portaled root in this package starts its class list with this. It
// matches no rule in an app whose preflight is global, so plaid-igt and
// plaid-dict are unaffected. plaid-igt carried the same class through its own
// migration and stripped it in 01978e17; retire this the same way once plaid-ud
// finishes Tier 0.5.
export const PREFLIGHT_SCOPE = 'tw';
