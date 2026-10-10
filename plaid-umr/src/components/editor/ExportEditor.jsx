import { DocumentFileExport } from '@ui/components/shared/DocumentFileExport.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { ExportProblems } from './ExportProblems.jsx';

export const ExportEditor = () => {
  // Project, document and the breadcrumbs/tab strip all come from
  // DocumentEditorShell, which guarantees both are loaded before this renders.
  const { doc, project } = useDocumentEditor();
  useDocumentTitle('Export', doc?.name, project?.name);

  // A value the file cannot hold refuses the export and is listed instead.
  const problems = doc.exportProblems;
  return (
    <DocumentFileExport
      heading="UMR"
      extension=".umr"
      name={doc?.name}
      content={problems.length ? '' : doc.toUmr()}
      notice={problems.length > 0 && <ExportProblems problems={problems} />}
      refused={problems.length > 0}
    />
  );
};
