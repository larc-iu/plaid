import { useMemo } from 'react';
import { markdownToSafeHtml } from '../../lib/markdown.js';
import { cn } from '../../lib/utils.js';
import './markdown.css';

// React's window onto the app's one Markdown renderer (src/lib/markdown.js).
//
// `dangerouslySetInnerHTML` is safe here and only here: the string has already
// been through DOMPurify, which is the whole point of routing every caller
// through `markdownToSafeHtml`. Do not hand this raw HTML from anywhere else.
//
// Styling comes from the caller's className. `md-body` carries the compact
// defaults (headings, lists, tables, code); the assistant layers Tailwind
// Typography's `prose` on top of it. `quotedForms` sets quoted runs in the
// face for language data (see markdownToSafeHtml).
export function SafeMarkdown({ children, className, quotedForms = false }) {
  const __html = useMemo(
    () => markdownToSafeHtml(children, { quotedForms }),
    [children, quotedForms],
  );
  return <div className={cn('md-body', className)} dangerouslySetInnerHTML={{ __html }} />;
}
