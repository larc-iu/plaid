import { Notice } from '@ui/components/shared/Notice.jsx';
import { DocumentFileExport } from '@ui/components/shared/DocumentFileExport.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { ConlluPreview } from './ConlluPreview.jsx';

export const ExportEditor = () => {
  // Project, document and the breadcrumbs/tab strip all come from
  // DocumentEditorShell, which guarantees both are loaded before this renders.
  const { doc, project } = useDocumentEditor();
  useDocumentTitle('Export', doc?.name, project?.name);

  const conlluContent = doc.toConllu();
  // What the notation cannot carry, said where the file is taken rather than
  // discovered when it is read back.
  const losses = doc.conlluLosses();

  return (
    <DocumentFileExport
      heading="CoNLL-U"
      extension=".conllu"
      name={doc?.name}
      content={conlluContent}
      notice={
        losses.length > 0 && (
          <Notice tone="warning">
            <p className="font-medium">This file cannot say everything the document does.</p>
            <ul className="mt-1 list-disc ps-5">
              {losses.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Notice>
        )
      }
    >
      {/* Sized to the document up to 400 rows: a treebank is read by
          scrolling one long column, not by scrolling a box inside a page. */}
      <ConlluPreview content={conlluContent} />
    </DocumentFileExport>
  );
};
