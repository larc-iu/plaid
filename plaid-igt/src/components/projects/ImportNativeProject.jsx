// "Import archive" — recreate a project from a Plaid IGT JSON export
// (docs/native-format.md). Flow: pick file → read + validate client-side →
// review (project name, archive contents) → run (shared project setup, then
// the native import engine) → done.
//
// Resume mirrors the FLEx import page: the created project id and setup
// completion live in refs for this page session, so Retry re-runs against the
// same project; the engine skips documents already marked done, redoes
// half-imported ones, and dedupes vocab items by their stamped archive id.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import {
  FileDropZone,
  ImportHeader,
  ImportRunPanel,
  ProjectNameField,
  ReadingPanel,
} from './ImportPanels';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { useAuth } from '../../contexts/AuthContext';
import { useClientApart } from '@/hooks/useClientApart';
import { notifyError, humanizeError } from '@/utils/feedback';
import { readNativeArchive } from '../../import/native/readArchive';
import { deriveSetupData, runNativeImport } from '../../import/native/importEngine';
import { useResumeImport } from '@/hooks/useResumeImport';
import { useProjectImportRun } from '@/hooks/useProjectImportRun';
import { countOf } from '@ui/lib/plural.js';

import { documentFraction, documentLabel } from '../../import/progress';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { NATIVE_IMPORT_KIND } from '@/domain/importFinish';
import { importEnding } from '@/domain/igtConfig';

export const ImportNativeProject = () => {
  useDocumentTitle('Import archive');
  const { client: session } = useAuth();
  // The run's own client, so a write made elsewhere in the tab meanwhile is
  // neither stamped with its document version nor filed under its operation.
  const client = useClientApart(session);
  const [archive, setArchive] = useState(null);
  const [projectName, setProjectName] = useState('');

  // Survive retries within this page session (see header comment).
  const { resumeId, resumeName, resumeProject, finishAsIs } = useResumeImport(client);
  // "Use the project as it is" began and did not finish: it is only ended again.
  const ending = importEnding(resumeProject?.config);
  const {
    stage,
    setStage,
    progress,
    runError,
    retryable,
    stopped,
    results,
    projectIdRef,
    setupDoneRef,
    stop,
    start,
  } = useProjectImportRun({ client, kind: NATIVE_IMPORT_KIND, resumeId });

  const handleFile = async (file) => {
    if (!file) return;
    setStage('parsing');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = readNativeArchive(bytes);
      setArchive(parsed);
      setProjectName(parsed.manifest.project?.name || file.name.replace(/\.zip$/i, ''));
      setStage('review');
    } catch (e) {
      console.error('Archive read failed:', e);
      notifyError(humanizeError(e), 'Failed to read the archive');
      setStage('pick');
    }
  };

  const startImport = () =>
    start({
      source: archive.manifest?.project?.name ?? null,
      setupData: () => deriveSetupData(archive.manifest, projectName.trim(), archive.vocabularies),
      run: ({ projectId, shouldStop, setProgress }) => {
        const totalDocs = archive.documents.length;
        return runNativeImport({
          client,
          projectId,
          archive,
          shouldStop,
          onProgress: (p) => {
            if (p.phase === 'vocabulary') {
              setProgress({
                label: `Importing vocabulary "${p.name}" (${p.done}/${p.total})`,
                pct: 15 + (p.total ? (p.done / p.total) * 15 : 15),
              });
            } else if (p.phase === 'document') {
              setProgress({
                label: documentLabel(p, totalDocs),
                pct: 30 + documentFraction(p, totalDocs) * 70,
              });
            }
          },
        });
      },
    });

  const manifest = archive?.manifest;
  const itemCount = archive?.vocabularies.reduce((n, v) => n + (v.data.items?.length ?? 0), 0) ?? 0;
  const mediaCount = archive?.documents.filter((d) => d.mediaBytes).length ?? 0;
  const fieldCount = manifest
    ? ['sentence', 'word', 'morpheme'].reduce(
        (n, k) => n + (manifest.schema?.fields?.[k]?.length ?? 0),
        0,
      )
    : 0;

  return (
    <div className={FORM_PAGE_WIDTH}>
      <div className="flex flex-col gap-6">
        <ImportHeader
          title="Import a Plaid IGT archive"
          resume={
            resumeId && {
              name: resumeName,
              again: ending
                ? 'Ending it as it is did not finish.'
                : 'Choose the same file: what is already there is unchanged.',
              onFinishAsIs: finishAsIs,
            }
          }
        >
          Recreate a project from a “Plaid IGT JSON” export: texts, analyses, vocabularies, time
          alignment, media, and provenance.
        </ImportHeader>

        {stage === 'pick' && !ending && (
          <FileDropZone
            onFiles={(files) => handleFile(files?.[0])}
            title="Drop an exported .zip archive here, or click to choose"
            hint="Produced by Export → “Plaid IGT JSON (lossless .zip archive)”"
            accept=".zip,application/zip"
          />
        )}

        {stage === 'parsing' && <ReadingPanel label="Reading archive…" />}

        {(stage === 'review' || stage === 'running' || stage === 'done') && archive && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">
                Contents of “{manifest.project?.name ?? 'archive'}”
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  exported{' '}
                  {manifest.exportedAt ? new Date(manifest.exportedAt).toLocaleString() : 'unknown'}
                  {manifest.asOf ? ` (as of ${new Date(manifest.asOf).toLocaleString()})` : ''}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>{countOf(archive.documents.length, 'document')}</p>
                <p>{countOf(archive.vocabularies.length, 'vocabulary', 'vocabularies')}</p>
                <p>{countOf(itemCount, 'entry', 'entries')}</p>
                <p>{countOf(fieldCount, 'annotation field')}</p>
                <p>
                  {countOf(
                    manifest.schema?.orthographies?.length ?? 0,
                    'orthography',
                    'orthographies',
                  )}
                </p>
                <p>{countOf(mediaCount, 'media file')}</p>
              </div>
            </div>

            <ProjectNameField
              id="native-project-name"
              value={resumeId ? (resumeName ?? '') : projectName}
              onChange={setProjectName}
              disabled={!!resumeId || stage !== 'review' || setupDoneRef.current}
              resuming={!!resumeId}
            />

            <ImportRunPanel
              stage={stage}
              runError={runError}
              retryable={retryable}
              stopped={stopped}
              progress={progress}
              onStop={stop}
            />

            {stage === 'done' && results && (
              <Notice tone="success" className="p-4">
                <p className="font-medium">
                  Imported {countOf(results.imported, 'document')}
                  {results.skipped ? ` (${results.skipped} already done)` : ''}
                  {results.redone ? ` (${results.redone} redone)` : ''}
                </p>
                {results.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {results.warnings.slice(0, 8).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {results.warnings.length > 8 && (
                      <li>…and {results.warnings.length - 8} more</li>
                    )}
                  </ul>
                )}
              </Notice>
            )}

            <div className="flex justify-end gap-2">
              {stage === 'review' && (retryable || !runError) && (
                <Button onClick={startImport} disabled={!projectName.trim()}>
                  {runError ? (
                    <>
                      <RefreshCw className="h-4 w-4" /> Retry import
                    </>
                  ) : (
                    'Create project and import'
                  )}
                </Button>
              )}
              {stage === 'done' && (
                <Button asChild>
                  <Link to={`/projects/${projectIdRef.current}`}>Open project</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
