import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { notifyError } from '../../utils/feedback.jsx';
import { ConlluPreview } from './ConlluPreview.jsx';

export const ExportEditor = () => {
  // Project, document and the breadcrumbs/tab strip all come from
  // DocumentEditorShell, which guarantees both are loaded before this renders.
  const { doc, project } = useDocumentEditor();
  const [copied, setCopied] = useState(false);

  useDocumentTitle('Export', doc?.name, project?.name);

  const conlluContent = doc.toConllu();
  // What the notation cannot carry, said where the file is taken rather than
  // discovered when it is read back.
  const losses = doc.conlluLosses();

  const handleCopy = async () => {
    // On a non-secure origin `navigator.clipboard` is undefined, and a denied
    // permission rejects. Either way the button used to keep saying "Copy"
    // with nothing said and an unhandled rejection in the console, and Download
    // is the only other way to get the text out.
    try {
      await navigator.clipboard.writeText(conlluContent);
    } catch {
      notifyError(
        'The clipboard is not available here. Download the file instead.',
        'Failed to copy',
      );
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

      {losses.length > 0 && (
        <Notice tone="warning">
          <p className="font-medium">This file cannot say everything the document does.</p>
          <ul className="mt-1 list-disc ps-5">
            {losses.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Notice>
      )}

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

      {/* Sized to the document up to 400 rows: a treebank is read by
          scrolling one long column, not by scrolling a box inside a page. */}
      <ConlluPreview content={conlluContent} />
    </div>
  );
};
