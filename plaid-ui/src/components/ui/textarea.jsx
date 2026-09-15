// Modified from shadcn: it takes a `compose` prop and a composed ref.
import * as React from 'react';
import { cn } from '../../lib/utils.js';
import { useComposeRef } from '../../hooks/useComposeRef.js';

/**
 * `compose` turns on the backslash composer, and `dir` defaults to `auto`. See
 * components/ui/input.jsx for both.
 */
const Textarea = React.forwardRef(({ className, compose = false, ...props }, ref) => {
  const setRef = useComposeRef(compose, ref);
  return (
    <textarea
      ref={setRef}
      dir="auto"
      className={cn(
        'flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
