import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn's class-name combiner: clsx for conditional classes + tailwind-merge to
// dedupe conflicting Tailwind utilities.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
