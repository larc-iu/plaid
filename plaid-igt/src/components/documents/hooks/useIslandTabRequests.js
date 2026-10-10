import { useEffect } from 'react';

// The interlinear island is framework-agnostic: its empty-state buttons ask to
// switch tabs with a DOM event (`igt:navigate-tab`) rather than reaching into
// the router. It is the only sender: a React tab calls `goToTab` off the
// document context instead.
export function useIslandTabRequests(goToTab) {
  useEffect(() => {
    const onNav = (e) => {
      const t = e.detail?.tab;
      if (t) goToTab(t);
    };
    window.addEventListener('igt:navigate-tab', onNav);
    return () => window.removeEventListener('igt:navigate-tab', onNav);
    // Re-subscribed when the setter changes: it closes over the current query
    // string, and a stale one would write the tab onto an outdated URL.
  }, [goToTab]);
}
