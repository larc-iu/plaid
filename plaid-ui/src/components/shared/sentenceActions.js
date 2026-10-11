import { cn } from '../../lib/utils.js';
import { buttonVariants } from '../ui/button.jsx';

// The actions on one sentence of an annotation surface, the same in every app:
// igt's Ask and Copy, ud's Edit metadata, Edit text, Ask and Comment, umr's
// Text, Ask and Comment. One quiet treatment for all of them, an icon and a
// label with no outline or fill until hover, because none is the thing a person
// came to the sentence to do. Quiet by weight, never by opacity: dimmed, the
// grey fell under 3:1. A toggle (umr's Text) shows its pressed state with the
// hover fill. SentenceComments wears it, and plaid-igt's lit-html island takes
// the same string.
export const SENTENCE_ACTION =
  'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-transparent bg-transparent px-2 text-xs font-normal text-[hsl(var(--foreground)/0.85)] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground';

// Accept and Discard beside them: outlined and small, coloured by the
// `plaid-review` pair in index.css.
export const SENTENCE_REVIEW = cn(buttonVariants({ variant: 'outline' }), 'h-6 gap-1 px-2 text-xs');
