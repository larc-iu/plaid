// Modified from shadcn: a trigger given `to` renders a real anchor, and the
// root drops Radix's duplicate onValueChange.
import * as React from 'react';
import { useHref } from 'react-router-dom';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../lib/utils.js';

// Radix fires `onValueChange` twice for a single trigger click (once when the
// trigger takes focus, once for the click). That was harmless while handlers
// only set React state, but every tab group here now writes the URL, and the
// duplicate would push a second identical history entry and cost the user an
// extra Back press. Both calls can land before React re-renders, so comparing
// against `value` alone is not enough: what was forwarded is remembered until
// the controlled value catches up.
// `guard`, where a group has one, is asked before the group leaves the tab it
// is on: it resolves to false to stay. The value is the caller's, so a change
// it never forwards is a change that never happens, and the anchor under a
// trigger has its click prevented either way, so nothing navigates behind the
// question. Both the mouse (Radix acts on mousedown) and the keyboard come
// through here.
const Tabs = React.forwardRef(({ value, onValueChange, guard, ...props }, ref) => {
  const sentRef = React.useRef(null);
  React.useEffect(() => {
    sentRef.current = null;
  }, [value]);

  const handleValueChange = React.useCallback(
    (next) => {
      if (!onValueChange || next === value || next === sentRef.current) return;
      sentRef.current = next;
      if (!guard) {
        onValueChange(next);
        return;
      }
      Promise.resolve(guard(next, value)).then((ok) => {
        // Asked and refused: the group stays where it is, and the next click
        // on the same tab asks again.
        if (ok) onValueChange(next);
        else if (sentRef.current === next) sentRef.current = null;
      });
    },
    [guard, onValueChange, value],
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

const NO_EDGES = { start: false, end: false, rtl: false };
const FADE = '2rem';
// The same width in pixels, for scrolling a tab clear of it.
const fadePx = () => 2 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

// Whether tabs lie past the start and the end of the strip, in its own
// direction. In a right-to-left box `scrollLeft` runs from 0 down to minus
// the overflow, so its size is what counts.
const hiddenEdges = (list) => {
  const overflow = list.scrollWidth - list.clientWidth;
  if (overflow <= 1) return NO_EDGES;
  const scrolled = Math.abs(list.scrollLeft);
  const rtl = getComputedStyle(list).direction === 'rtl';
  return { start: scrolled > 1, end: scrolled < overflow - 1, rtl };
};

// Kept when nothing changed, so a scroll does not re-render the strip.
const sameEdges = (a, b) => a.start === b.start && a.end === b.end && a.rtl === b.rtl;

const fadeMask = ({ start, end, rtl }) => {
  if (!start && !end) return null;
  const toward = rtl ? 'to left' : 'to right';
  const from = start ? `transparent, black ${FADE}` : 'black';
  const to = end ? `black calc(100% - ${FADE}), transparent` : 'black';
  return `linear-gradient(${toward}, ${from}, ${to})`;
};

// A tab strip that does not fit SCROLLS, and keeps the tab you are on in
// sight. It used to be an inline-flex row of nowrap triggers with nowhere to
// go: below about 950px the eight project tabs were simply clipped, and the
// one you were standing on could be off the right-hand edge, so the screen
// gave no clue which of them you were looking at.
const TabsList = React.forwardRef(({ className, style, onScroll, ...props }, ref) => {
  const inner = React.useRef(null);
  React.useImperativeHandle(ref, () => inner.current);
  // Which edges have tabs past them. Those edges fade out, which is the only
  // sign of more tabs where the scrollbar is an overlay that shows only while
  // scrolling (macOS, most trackpads).
  const [edges, setEdges] = React.useState(NO_EDGES);
  const measure = React.useCallback(() => {
    const list = inner.current;
    if (!list) return;
    const next = hiddenEdges(list);
    setEdges((prev) => (sameEdges(prev, next) ? prev : next));
  }, []);

  // Radix flips `data-state` on the triggers rather than re-rendering this, so
  // watch the attribute instead of reacting to a prop.
  React.useEffect(() => {
    const list = inner.current;
    if (!list) return undefined;
    const reveal = () => {
      const active = list.querySelector('[data-state="active"]');
      if (active) {
        // Clear of the fade as well as inside the box: a tab brought just to
        // the edge sat under the fade, cut and pale, when more tabs lay past
        // it. Instant, not smooth: landing on a screen should not animate its
        // tab strip sideways. Only the strip scrolls, never the page.
        const room = fadePx();
        const box = list.getBoundingClientRect();
        const tab = active.getBoundingClientRect();
        const slack = tab.left - box.left - room;
        if (slack < 0) list.scrollLeft += slack;
        else if (tab.right > box.right - room) {
          list.scrollLeft += Math.min(tab.right - (box.right - room), slack);
        }
      }
      measure();
    };
    // After a frame as well as now: on the first mount the triggers are often
    // not in the DOM yet, and the tab that is already active is BORN with
    // data-state="active" rather than mutating into it, so waiting for a
    // mutation alone leaves the first paint scrolled to the left.
    const frame = requestAnimationFrame(reveal);
    reveal();
    const changed = new MutationObserver(reveal);
    changed.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });

    // A strip that gets narrower (the window, or the page's own scrollbar
    // arriving once the content loads) brings the current tab back into
    // sight. Any other change in size is measured only, so a strip the
    // reader scrolled stays where they left it. The tabs are watched too:
    // once the strip is as wide as its box, a label that grows (a count going
    // from 9 to 10) changes what overflows without changing the strip.
    let width = list.clientWidth;
    const resized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (list.clientWidth !== width) {
              width = list.clientWidth;
              reveal();
            } else measure();
          });
    const watch = () => {
      if (!resized) return;
      resized.observe(list);
      for (const tab of list.children) resized.observe(tab);
    };
    watch();
    const added = new MutationObserver(watch);
    added.observe(list, { childList: true });
    return () => {
      cancelAnimationFrame(frame);
      changed.disconnect();
      added.disconnect();
      resized?.disconnect();
    };
  }, [measure]);

  // Start-aligned, never centred: a centred row that overflows spills past its
  // START edge too, where no scroll position reaches, and the first tab was
  // cut to "cuments". The height is a minimum so that a classic scrollbar
  // (Windows, Linux) sits under the tabs instead of over their underline.
  const mask = fadeMask(edges);
  return (
    <TabsPrimitive.List
      ref={inner}
      className={cn(
        'inline-flex min-h-9 max-w-full items-center justify-start gap-1 overflow-x-auto overflow-y-hidden border-b text-muted-foreground [scrollbar-width:thin]',
        className,
      )}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask, ...style } : style}
      onScroll={(e) => {
        measure();
        onScroll?.(e);
      }}
      {...props}
    />
  );
});
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
