import * as React from 'react';
import { cn } from '@/lib/utils';
import { useCompose } from '@/hooks/useCompose';

/** `compose` turns on the backslash composer. See components/ui/input.jsx. */
const Textarea = React.forwardRef(({ className, compose = false, ...props }, ref) => {
  const setRef = useCompose(compose, ref);
  return (
    <textarea
      ref={setRef}
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
