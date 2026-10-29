// "Import ELAN" — create a project from a folder of .eaf files.
// Flow: pick files → read + compare tiers → review (name, the tier
// mapping, what each tier becomes) → run (shared project setup, then the ELAN
// import engine) → done.
//
// The batch is refused outright when a tier becomes different things in
// different files. One mapping is applied to the whole corpus, so such a file
// would be imported under decisions that were never made for it. Files whose
// trees differ otherwise are one batch: see import/elan/schema.js for how
// their tiers are matched (participants are normalized out, so files by
// different speakers still match).
//
// Reading the batch and mapping its tiers is `useElanBatch` + `ElanTierReview`,
// shared with ImportElanDocuments, which runs the same import into a project
// that already exists. What is particular to this page is the project it
// creates first. A run that stops leaves a project that is only deleted
// (useProjectImportRun).

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileDropZone,
  FinishPending,
  ImportHeader,
  ImportRunPanel,
  Panel,
  ProjectNameField,
  WarningLog,
} from './ImportPanels.jsx';
import { Button } from '@ui/components/ui/button';
import { useAuth } from '../../contexts/AuthContext';
import { useClientApart } from '@/hooks/useClientApart';
import { notifyError, humanizeError } from '@/utils/feedback';
import { deriveSetupData, runElanImport } from '../../import/elan/importEngine';
import { useProjectImportRun } from '@/hooks/useProjectImportRun';

import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { partitionPicked, useElanBatch } from './elan/useElanBatch';
import { ElanProblems, ElanTierReview, SchemaMismatch } from './elan/ElanTierReview.jsx';
import { elanCounts } from '@/import/elan/preview.js';
import { ElanFiles } from './elan/ElanFiles.jsx';
import { ElanPreview } from './elan/ElanPreview.jsx';
import { useMediaDurations } from './elan/useMediaDurations';
import { useRecordingConversion } from './elan/useRecordingConversion';
import { useServerLimits } from '@/hooks/useServerLimits';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { countOf } from '@ui/lib/plural.js';

export const ImportElanProject = () => {
  useDocumentTitle('Import ELAN');
  const { client: session } = useAuth();
  // The run's own client, so a write made elsewhere in the tab meanwhile is
  // neither stamped with its document version nor filed under its operation.
  const client = useClientApart(session);
  const fileInputRef = useRef(null);
  const [projectName, setProjectName] = useState('');
  // Every warning the run raises, in order, kept on screen while it happens
  // rather than only tallied at the end.
  const [log, setLog] = useState([]);

  const batch = useElanBatch();
  const limits = useServerLimits();
  const conversion = useRecordingConversion(batch.setMediaFiles);
  const durations = useMediaDurations(batch.mediaFiles);
  const {
    stage,
    setStage,
    progress,
    runError,
    stopped,
    results,
    projectIdRef,
    unfinished,
    clearUnfinished,
    finishPending,
    retryFinish,
    stop,
    start,
  } = useProjectImportRun({ client, kind: 'ELAN' });

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
      notifyError(humanizeError(e), 'Failed to read the files');
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

  // The answers lock while a stopped run's project is still there.
  const editable = stage === 'review' && !unfinished;
  const canRun =
    editable && !!batch.build && !!projectName.trim() && batch.undecidedNearMisses.length === 0;

  return (
    <div className={FORM_PAGE_WIDTH}>
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
        <ImportHeader title="Import an ELAN corpus">
          Create a project from a set of{' '}
          <a
            href="https://archive.mpi.nl/tla/elan"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            ELAN
          </a>{' '}
          annotation files. Every file becomes one document. A tier must mean the same thing in
          every file.
        </ImportHeader>

        {stage === 'pick' && (
          <FileDropZone
            onFiles={handleFiles}
            hint="Drop your .eaf files and their recordings here, or choose them below."
            onChoose={() => fileInputRef.current?.click()}
            chooseLabel="Choose .eaf files and recordings"
          />
        )}

        {stage === 'parsing' && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {batch.decoding ? `Converting ${batch.decoding} to PCM WAV.` : 'Reading files…'}
          </p>
        )}
        {stage !== 'parsing' && batch.decoding && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Converting {batch.decoding} to PCM WAV.
          </p>
        )}

        {(stage === 'review' || stage === 'running') && batch.comparison && (
          <div className="flex flex-col gap-6">
            {!batch.comparison.consistent && (
              <SchemaMismatch
                batch={batch}
                onReset={() => {
                  batch.reset();
                  setStage('pick');
                }}
              />
            )}

            {batch.comparison.consistent && (
              <>
                <ProjectNameField
                  id="project-name"
                  value={projectName}
                  onChange={setProjectName}
                  disabled={!editable}
                />

                <ElanFiles
                  files={batch.files}
                  mediaFiles={batch.mediaFiles}
                  media={batch.media}
                  durations={durations}
                  maxBytes={limits?.mediaFileBytes ?? null}
                  editable={editable}
                  converting={conversion.converting}
                  documents={batch.build?.documents ?? null}
                  onAddFiles={() => fileInputRef.current?.click()}
                  onRemoveEaf={batch.removeEaf}
                  onRemoveMedia={batch.removeMedia}
                  onConvert={conversion.convertRecordings}
                  onStopConverting={conversion.stopConverting}
                  recordMediaName={batch.recordMediaName}
                  onRecordMediaName={batch.setRecordMediaName}
                />

                <ElanTierReview batch={batch} editable={editable} />

                <ElanPreview build={batch.build} />

                <ElanProblems batch={batch} />

                <ImportRunPanel
                  stage={stage}
                  runError={runError}
                  stopped={stopped}
                  unfinished={unfinished}
                  client={client}
                  onDeleted={clearUnfinished}
                  progress={progress}
                  onStop={stop}
                >
                  {log.length > 0 && <WarningLog log={log} />}
                </ImportRunPanel>

                <div className="flex items-center gap-2">
                  {!unfinished && (
                    <Button onClick={startImport} disabled={!canRun}>
                      Import
                    </Button>
                  )}
                  <span className="ms-2 text-xs text-muted-foreground">
                    {elanCounts(batch.build)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-4">
            {finishPending && <FinishPending onRetry={retryFinish} />}
            <Panel tone="success" title="Import complete">
              <p className="mt-1 text-xs">{results.imported} imported.</p>
            </Panel>
            {log.length > 0 ? (
              <WarningLog log={log} />
            ) : (
              results.warnings.length > 0 && (
                <Panel tone="warning" title={`${countOf(results.warnings.length, 'warning')}`}>
                  <ul className="mt-1 list-inside list-disc text-xs">
                    {results.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Panel>
              )
            )}
            {!finishPending && (
              <div>
                <Button asChild>
                  <Link to={`/projects/${projectIdRef.current}`}>Open project</Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
