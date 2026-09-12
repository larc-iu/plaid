import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { useDocumentEditor } from './useDocumentEditor.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { notifyError } from '../../utils/feedback.jsx';

export const ExportEditor = () => {
  // Project, document and the breadcrumbs/tab strip all come from
  // DocumentEditorShell, which guarantees both are loaded before this renders.
  const { doc, project } = useDocumentEditor();
  const [copied, setCopied] = useState(false);

  useDocumentTitle('Export', doc?.name, project?.name);

  const conlluContent = doc.toConllu();

  const handleCopy = async () => {
    // On a non-secure origin `navigator.clipboard` is undefined, and a denied
    // permission rejects. Either way the button used to keep saying "Copy"
    // with nothing said and an unhandled rejection in the console, and Download
    // is the only other way to get the text out.
    try {
      await navigator.clipboard.writeText(conlluContent);
    } catch {
      notifyError('The clipboard is not available here. Download the file instead.', 'Not copied');
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([conlluContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${doc?.name || 'document'}.conllu`;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl font-semibold tracking-tight">CoNLL-U</h3>

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" onClick={handleDownload}>
          <Download className="h-4 w-4" />
          Download
        </Button>
      </div>

      {/* Read-only and sized to the document: a treebank is read by scrolling
          one long column, not by scrolling a box inside a page. */}
      <textarea
        value={conlluContent}
        spellCheck={false}
        readOnly
        rows={Math.min(Math.max(conlluContent.split('\n').length, 20), 400)}
        className="w-full rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>
  );
};
