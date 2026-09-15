// Modified from shadcn: it takes a `compose` prop and a composed ref.
import * as React from 'react';
import { cn } from '../../lib/utils.js';
import { useComposeRef } from '../../hooks/useComposeRef.js';

/**
 * `compose` turns on the backslash character composer (`\sw` -> ə). Opt in on
 * fields that hold language data. Leave it off wherever a backslash has to
 * stay literal: regex search, passwords, URLs, timecodes.
 *
 * `dir="auto"` is the DEFAULT, and a caller can override it because `props` is
 * spread after. Every field in these apps can be typed into in any script, and
 * a field holding Arabic needs its caret, its selection and its punctuation on
 * the correct side whatever the page around it is doing. It changes nothing at
 * all for a value with no strong RTL character in it.
 *
 * Pass `dir="ltr"` where the value is a FORMAT rather than a sentence: a regex,
 * a tab-separated paste, a path. There the structure is what has to stay
 * legible, and one Arabic literal would otherwise flip the whole field.
 */
const Input = React.forwardRef(({ className, type, compose = false, ...props }, ref) => {
  const setRef = useComposeRef(compose, ref);
  return (
    <input
      type={type}
      ref={setRef}
      dir="auto"
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
