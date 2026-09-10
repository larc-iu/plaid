// "Import ELAN" — create a project from a folder of .eaf files.
// Flow: pick files → read + compare tier structures → review (name, the tier
// mapping, what each tier becomes) → run (shared project setup, then the ELAN
// import engine) → done.
//
// The batch is refused outright unless every file has the same tier structure.
// One mapping is applied to the whole corpus, so a file with different tiers
// would be imported under decisions that were never made for it. See
// import/elan/schema.js for what "the same structure" means (participants are
// normalized out, so files by different speakers still match).
//
// Reading the batch and mapping its tiers is `useElanBatch` + `ElanTierReview`,
// shared with ImportElanDocuments, which runs the same import into a project
// that already exists. What is particular to this page is the project it
// creates first.
//
// Resume mirrors the other import pages: the created project id and setup
// completion live in refs for this page session, so Retry re-runs against the
// same project and the engine skips documents already marked done.

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Check, RefreshCw, Square, AlertTriangle } from 'lucide-react';
import { Panel, WarningLog } from './ImportPanels.jsx';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError } from '@/utils/feedback';
import { deriveSetupData, runElanImport } from '../../import/elan/importEngine';
import { useResumeImport } from '@/hooks/useResumeImport';
import { useProjectImportRun } from '@/hooks/useProjectImportRun';

import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { partitionPicked, useElanBatch } from './elan/useElanBatch';
import { ElanBuildSummary, ElanTierReview, SchemaMismatch } from './elan/ElanTierReview.jsx';
import { ElanDocumentsPanel } from './elan/ElanDocumentsPanel.jsx';
import { ElanStagedFiles } from './elan/ElanStagedFiles.jsx';
import { useMediaDurations } from './elan/useMediaDurations';
import { useRecordingConversion } from './elan/useRecordingConversion';
import { useServerLimits } from '@/hooks/useServerLimits';

export const ImportElanProject = () => {
  useDocumentTitle('Import ELAN');
  const { client } = useAuth();
  const fileInputRef = useRef(null);
  const [projectName, setProjectName] = useState('');
  // Every warning the run raises, in order, kept on screen while it happens
  // rather than only tallied at the end.
  const [log, setLog] = useState([]);

  const batch = useElanBatch();
  const limits = useServerLimits();
  const conversion = useRecordingConversion(batch.setMediaFiles);
  const durations = useMediaDurations(batch.mediaFiles);
  const { resumeId, resumeName, finishAsIs } = useResumeImport(client);
  const { stage, setStage, progress, runError, results, projectIdRef, stop, start } =
    useProjectImportRun({ client, kind: 'ELAN', resumeId });

  const handleFiles = async (fileList) => {
    // Cancelling the file dialog is not an error to report at someone.
    if (!fileList || fileList.length === 0) return;
    // Recordings added from the review step carry no .eaf, and re-reading is
    // what would throw the tier mapping away.
    if (partitionPicked(fileList).eafs.length) setStage('parsing');
    try {
      await batch.readFiles(fileList);
      setProjectName((name) => name || 'ELAN corpus');
      setStage('review');
    } catch (e) {
      console.error('ELAN read failed:', e);
      notifyError(e.message, 'Could not read the files');
      setStage(batch.files ? 'review' : 'pick');
    }
  };

  const startImport = () => {
    setLog([]);
    return start({
      setupData: () => deriveSetupData(batch.build, projectName.trim()),
      run: ({ projectId, shouldStop, setProgress }) =>
        runElanImport({
          client,
          projectId,
          build: batch.build,
          shouldStop,
          onWarning: (text, { document }) => setLog((l) => [...l, { text, document }]),
          onProgress: (p) => {
            if (p.phase !== 'document') return;
            const n = (p.index ?? 0) + 1;
            const total = p.total ?? batch.build.documents.length;
            setProgress({
              label: `${p.doc}${p.step ? `: ${p.step}` : ''} (${n}/${total})`,
              pct: 15 + (n / total) * 85,
            });
          },
        }),
    });
  };

  const editable = stage === 'review';
  const canRun =
    editable && !!batch.build && !!projectName.trim() && batch.undecidedNearMisses.length === 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Outside the pick step: the review step reopens it to add recordings. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".eaf,audio/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
          <span>/</span>
          <Link to="/projects/new" className="hover:text-foreground hover:underline">
            New Project
          </Link>
          <span>/</span>
          <span>Import ELAN</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">Import an ELAN corpus</h1>
          <p className="text-sm text-muted-foreground">
            Create a project from a set of{' '}
            <a
              href="https://archive.mpi.nl/tla/elan"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              ELAN
            </a>{' '}
            annotation files. Every file becomes one document, and every file must share the same
            tier structure so one set of decisions covers the whole corpus.
          </p>
          {resumeId && (
            <p className="mt-2 text-sm">
              Continuing the unfinished import into{' '}
              <span className="font-medium">{resumeName ?? 'this project'}</span>. Choose the same
              files: what is already there is kept.{' '}
              <button
                type="button"
                onClick={finishAsIs}
                className="font-medium text-primary hover:underline"
              >
                Use the project as it is
              </button>
            </p>
          )}
        </div>

        {stage === 'pick' && (
          <div
            className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-10 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer.files);
            }}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Drop your .eaf files and their recordings here, or choose them below.
            </p>
            <Button onClick={() => fileInputRef.current?.click()}>
              Choose .eaf files and recordings
            </Button>
          </div>
        )}

        {stage === 'parsing' && <p className="text-sm text-muted-foreground">Reading files…</p>}

        {(stage === 'review' || stage === 'running') && batch.comparison && (
          <div className="flex flex-col gap-6">
            {!batch.comparison.consistent && (
              <SchemaMismatch
                comparison={batch.comparison}
                onReset={() => {
                  batch.reset();
                  setStage('pick');
                }}
              />
            )}

            {batch.comparison.consistent && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="project-name">Project name</Label>
                  <Input
                    id="project-name"
                    value={resumeId ? (resumeName ?? '') : projectName}
                    disabled={!!resumeId || !editable}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="max-w-md"
                  />
                  {resumeId && (
                    <p className="text-xs text-muted-foreground">
                      Continuing an import into this project. What it already holds is kept.
                    </p>
                  )}
                </div>

                <ElanTierReview batch={batch} editable={editable} />

                <ElanStagedFiles
                  files={batch.files}
                  mediaFiles={batch.mediaFiles}
                  media={batch.media}
                  durations={durations}
                  maxBytes={limits?.mediaFileBytes ?? null}
                  editable={editable}
                  converting={conversion.converting}
                  onAddFiles={() => fileInputRef.current?.click()}
                  onRemoveEaf={batch.removeEaf}
                  onRemoveMedia={batch.removeMedia}
                  onConvert={conversion.convertRecordings}
                />

                <ElanDocumentsPanel build={batch.build} />

                <ElanBuildSummary batch={batch} />

                {runError && (
                  <Panel tone="error" icon={AlertTriangle} title="Import failed">
                    <p className="mt-1 text-xs">{runError}</p>
                    <p className="mt-1 text-xs">
                      Retrying continues in the same project: finished documents are skipped.
                    </p>
                  </Panel>
                )}

                {log.length > 0 && <WarningLog log={log} />}

                {stage === 'running' && progress && (
                  <div className="flex flex-col gap-2">
                    <div className="h-2 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${Math.min(100, Math.round(progress.pct))}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">{progress.label}</p>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button onClick={startImport} disabled={!canRun}>
                    {runError ? (
                      <>
                        <RefreshCw className="h-4 w-4" /> Retry import
                      </>
                    ) : (
                      'Import'
                    )}
                  </Button>
                  {stage === 'running' && (
                    <Button variant="outline" onClick={stop}>
                      <Square className="h-4 w-4" /> Stop
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-4">
            <Panel icon={Check} title="Import complete">
              <p className="mt-1 text-xs">
                {results.imported} imported
                {results.skipped ? `, ${results.skipped} already done` : ''}
                {results.redone ? `, ${results.redone} redone` : ''}.
              </p>
            </Panel>
            {log.length > 0 ? (
              <WarningLog log={log} />
            ) : (
              results.warnings.length > 0 && (
                <Panel
                  tone="warn"
                  icon={AlertTriangle}
                  title={`${results.warnings.length} warning${results.warnings.length === 1 ? '' : 's'}`}
                >
                  <ul className="mt-1 list-inside list-disc text-xs">
                    {results.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Panel>
              )
            )}
            <div>
              <Button asChild>
                <Link to={`/projects/${projectIdRef.current}`}>Open the project</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
