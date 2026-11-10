import { useEffect } from 'react';
import { DocumentFileExport } from '@ui/components/shared/DocumentFileExport.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { DOC_GUTTER } from '@ui/lib/pageWidth.js';
import { useRepairOnOpen } from './hooks/useRepairOnOpen.js';
import { ExportProblems, LeftOutOfExport } from './ExportProblems.jsx';

export const ExportEditor = () => {
  // Project, document and the breadcrumbs/tab strip all come from
  // DocumentEditorShell, which guarantees both are loaded before this renders.
  const { doc, project } = useDocumentEditor();
  useDocumentTitle('Export', doc?.name, project?.name);
  // The repair on open, as Annotate runs it, so the file carries the names
  // it gives (a sentence IGT moved renumbers its variables).
  const reconciling = useRepairOnOpen();
  // The vocabularies, for the type each linked morpheme goes by, which sets
  // the joints of the gloss lines. The file is written again once they are
  // read.
  useEffect(() => {
    doc?.loadLexicon?.().catch((err) => console.warn('Could not read the vocabularies:', err));
  }, [doc]);

  if (reconciling) return <Loading label="Checking this document…" className={DOC_GUTTER} />;
  // A value the file cannot hold refuses the export and is listed instead.
  const problems = doc.exportProblems;
  // What the file leaves out, when it is written at all.
  const leftOut = problems.length ? [] : (doc.leftOutOfExport ?? []);
  return (
    <DocumentFileExport
      heading="UMR"
      extension=".umr"
      name={doc?.name}
      content={problems.length ? '' : doc.toUmr()}
      notice={
        problems.length > 0 ? (
          <ExportProblems problems={problems} />
        ) : (
          leftOut.length > 0 && <LeftOutOfExport parts={leftOut} />
        )
      }
      refused={problems.length > 0}
    />
  );
};
