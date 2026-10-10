import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Button } from '../ui/button';
import { copyText, saveBlob, sanitizeFilename } from '../../lib/download.js';

/**
 * A document's Export tab in plaid-ud and plaid-umr: the document in one
 * file format, to copy or to download as `<document name><extension>`, and
 * shown below.
 *
 * - `heading`: the format's name.
 * - `content`: the file's text.
 * - `notice`: what is said above the buttons (what the file cannot carry).
 * - `refused`: the file cannot be made, so there is nothing to copy, save or
 *   show.
 * - `children`: the app's own view of the text, in place of the plain one.
 */
export const DocumentFileExport = ({
  heading,
  extension,
  name,
  content,
  notice = null,
  refused = false,
  children,
}) => {
  const [copied, setCopied] = useState(false);

  // Download is the other way to get the text out, so a copy refused says so.
  const handleCopy = async () => {
    const ok = await copyText(
      content,
      'The clipboard is not available here. Download the file instead.',
    );
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () =>
    saveBlob(
      new Blob([content], { type: 'text/plain;charset=utf-8' }),
      `${sanitizeFilename(name || 'document')}${extension}`,
    );

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl font-semibold tracking-tight">{heading}</h3>

      {notice}

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleCopy} disabled={refused}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" onClick={handleDownload} disabled={refused}>
          <Download className="h-4 w-4" />
          Download
        </Button>
      </div>

      {/* Read-only and sized to the document: a corpus is read by scrolling one
          long column, not by scrolling a box inside a page. */}
      {!refused &&
        (children ?? (
          <textarea
            value={content}
            spellCheck={false}
            readOnly
            rows={Math.min(Math.max(content.split('\n').length, 20), 400)}
            className="w-full rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        ))}
    </div>
  );
};
