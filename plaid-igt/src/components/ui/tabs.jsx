import * as React from 'react';
import { useHref } from 'react-router-dom';
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

const triggerClasses = (className) =>
  cn(
    'inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-sm font-medium transition-colors',
    'hover:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
    'data-[state=active]:border-primary data-[state=active]:text-foreground',
    'no-underline',
    className,
  );

// Every tab group here addresses a URL, so a trigger given `to` renders as a
// real anchor and behaves like any other link: middle-click and cmd-click open
// it in a new tab, and the right-click menu offers the same. Radix keeps
// ownership of ordinary activation (it acts on mousedown), so a plain click is
// cancelled here and a modified one is handed to the browser untouched.
const isModified = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

const TabsTrigger = React.forwardRef(({ className, to, children, ...props }, ref) => {
  // `useHref` spells the link the way the router does (a `#/...` fragment under
  // HashRouter). Called unconditionally, so a placeholder stands in when a
  // trigger has no destination.
  const href = useHref(to || '.');
  if (!to) {
    return (
      <TabsPrimitive.Trigger ref={ref} className={triggerClasses(className)} {...props}>
        {children}
      </TabsPrimitive.Trigger>
    );
  }
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      asChild
      // Radix composes this ahead of its own mousedown handler and skips that
      // handler once the event is defaulted-prevented, which is how a modified
      // click avoids switching the tab in THIS window as well as opening a new
      // one.
      onMouseDown={(e) => {
        if (isModified(e)) e.preventDefault();
      }}
      {...props}
    >
      <a
        href={href}
        className={triggerClasses(className)}
        onClick={(e) => {
          // Radix already switched the tab on mousedown, so the anchor must not
          // navigate again. Modified clicks were never Radix's to handle.
          if (!isModified(e)) e.preventDefault();
        }}
      >
        {children}
      </a>
    </TabsPrimitive.Trigger>
  );
});
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
