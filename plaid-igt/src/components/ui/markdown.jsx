import { useMemo } from 'react';
import { markdownToSafeHtml } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import './markdown.css';

// React's window onto the app's one Markdown renderer (src/lib/markdown.js).
//
// `dangerouslySetInnerHTML` is safe here and only here: the string has already
// been through DOMPurify, which is the whole point of routing every caller
// through `markdownToSafeHtml`. Do not hand this raw HTML from anywhere else.
//
// Styling comes from the caller's className. `md-body` carries the compact
// defaults (headings, lists, tables, code); the assistant layers Tailwind
// Typography's `prose` on top of it.
export function SafeMarkdown({ children, className }) {
  const __html = useMemo(() => markdownToSafeHtml(children), [children]);
  return <div className={cn('md-body', className)} dangerouslySetInnerHTML={{ __html }} />;
}
