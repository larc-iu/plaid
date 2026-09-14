import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTabParam } from '@/hooks/useTabParam';

// The tab bar's inventory, in display order, and the tab a document opens on.
const TABS = ['metadata', 'baseline', 'media', 'tokenize', 'analyze', 'comments', 'export'];
const DEFAULT_TAB = 'metadata';

// Which tab of a document is showing, and the two things that change it on
// nobody's click.
//
// The selection lives in `?tab=`, so a reload, a bookmark, and the back button
// all keep the tab the reader was on, and a search or concordance
// click-through can open the document straight onto Analyze. Every tab writes
// itself, Metadata included: here a bare URL means "no tab chosen", which is
// what the landing below reads, so Metadata cannot also be the bare URL
// without becoming unshareable.
export function useDocumentTabs({ doc, asOf }) {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab, tabHref] = useTabParam(TABS, DEFAULT_TAB, {
    writeFallback: true,
  });

  // The interlinear island is framework-agnostic; its empty-state CTA asks to
  // switch tabs via a DOM event rather than reaching into the router. It is the
  // only sender: a React tab calls `goToTab` off the document context instead.
  useEffect(() => {
    const onNav = (e) => {
      const t = e.detail?.tab;
      if (t) setActiveTab(t);
    };
    window.addEventListener('igt:navigate-tab', onNav);
    return () => window.removeEventListener('igt:navigate-tab', onNav);
    // Re-subscribed when the setter changes: it closes over the current query
    // string, and a stale one would write the tab onto an outdated URL.
  }, [setActiveTab]);

  // Land on Analyze when the document is already tokenized — the work surface
  // shouldn't be buried behind Metadata. Once, on the first live load only (not
  // on time-travel reloads or after the user has navigated tabs themselves).
  // An explicit tab request in the URL wins over the landing.
  const didAutoTabRef = useRef(!!searchParams.get('tab'));
  useEffect(() => {
    if (!doc || asOf || didAutoTabRef.current) return;
    didAutoTabRef.current = true;
    try {
      // Replace, not push: the user did not ask for this tab, so the back
      // button should leave the document instead of undoing the landing.
      if ((doc.sentences || []).some((s) => s.tokens.length > 0))
        setActiveTab('analyze', { replace: true });
    } catch {
      /* derivation not ready; leave default */
    }
  }, [doc, asOf, setActiveTab]);

  return [activeTab, setActiveTab, tabHref];
}
