import * as React from 'react';
import { cn } from '@/lib/utils';
import { useCompose } from '@/hooks/useCompose';

/**
 * `compose` turns on the backslash character composer (`\sw` -> ə). Opt in on
 * fields that hold language data. Leave it off wherever a backslash has to
 * stay literal: regex search, passwords, URLs, timecodes.
 */
const Input = React.forwardRef(({ className, type, compose = false, ...props }, ref) => {
  const setRef = useCompose(compose, ref);
  return (
    <input
      type={type}
      ref={setRef}
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
