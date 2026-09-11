import { SafeMarkdown } from '../ui/markdown.jsx';

// Standard chat markdown: GFM (tables, task lists, strikethrough) through the
// app's one renderer, styled with Tailwind Typography over the shared
// `md-body` defaults. Tables scroll sideways instead of breaking the column
// and links open in a new tab, both handled in markdown.css / lib/markdown.js
// rather than by per-element component overrides.
//
// On its own file rather than in the tab, because the admin area renders a
// whole conversation with it and has no business loading the tab's turn
// registry to do so.
export const AssistantMarkdown = ({ children }) => (
  <SafeMarkdown className="prose prose-sm max-w-none leading-relaxed dark:prose-invert prose-p:my-3.5 prose-headings:mt-6 prose-headings:mb-2.5 prose-pre:my-3 prose-table:my-4 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-hr:my-5">
    {children}
  </SafeMarkdown>
);
