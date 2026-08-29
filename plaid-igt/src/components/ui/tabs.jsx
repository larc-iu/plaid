import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

// Radix fires `onValueChange` twice for a single trigger click (once when the
// trigger takes focus, once for the click). That was harmless while handlers
// only set React state, but every tab group here now writes the URL, and the
// duplicate would push a second identical history entry and cost the user an
// extra Back press. Both calls can land before React re-renders, so comparing
// against `value` alone is not enough: what was forwarded is remembered until
// the controlled value catches up.
const Tabs = React.forwardRef(({ value, onValueChange, ...props }, ref) => {
  const sentRef = React.useRef(null);
  React.useEffect(() => {
    sentRef.current = null;
  }, [value]);

  const handleValueChange = React.useCallback(
    (next) => {
      if (!onValueChange || next === value || next === sentRef.current) return;
      sentRef.current = next;
      onValueChange(next);
    },
    [onValueChange, value],
  );

  return (
    <TabsPrimitive.Root
      ref={ref}
      value={value}
      onValueChange={onValueChange && handleValueChange}
      {...props}
    />
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-9 items-center justify-center gap-1 border-b text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-sm font-medium transition-colors',
      'hover:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:border-primary data-[state=active]:text-foreground',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('mt-4 focus-visible:outline-none', className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
