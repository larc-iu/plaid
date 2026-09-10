import { useRef, useState } from 'react';
import { executeProjectSetup } from '@/components/projects/setup/executeSetup';
import { markImportStarted, markImportFinished } from '@/domain/igtConfig';
import { ImportCancelled } from '@/import/resume';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/feedback';

// The run of a project import, shared by the four wizards that make a project
// from a file (FLEx, CLDF, ELAN, the archive). A wizard reads its file, shows
// a review, and then calls `start` with what differs: the setup-wizard input
// its file implies, the lexicon the record should name, and the engine call.
// Everything around that is the same for all of them and lives here: the
// stages, the progress bar, the stop flag, the import record on the project,
// the finished-and-warnings toasts, and the retry that continues where it
// left off.
//
// Setup runs once per page session and the record goes on the project the
// moment it exists, so a setup that fails part way leaves a project that
// reopens this import rather than one with no way back into it. The record is
// rewritten after setup (with the lexicon, once there is one) and removed when
// the run finishes, so a cancelled or lost import shows on the project rather
// than passing for a complete one.
//
//   client, kind, resumeId:  the app client, the record's kind ("FLEx"), and
//                            the project being resumed, if any
//   start({ source, setupData, setupShare, vocabId, requireVocab, run })
//     source:       what the record names as the file (or null)
//     setupData:    the setup-wizard input, or a function that makes it
//     setupShare:   how much of the bar setup takes, 0.15 unless said
//     vocabId:      the lexicon to record: an id, null, or an async function
//                   of { projectId, setup } (setup is null once it has run)
//     requireVocab: the error to raise when no lexicon could be found, after
//                   the record is written so the project is still flagged
//     run:          ({ projectId, vocabId, shouldStop, setProgress }) => the
//                   engine's result, with `imported` and maybe `warnings`
export function useProjectImportRun({ client, kind, resumeId }) {
  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  const [progress, setProgress] = useState(null); // {label, pct} | null
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState(null);
  const projectIdRef = useRef(resumeId || null);
  const setupDoneRef = useRef(false);
  const stopRef = useRef(false);

  const start = async ({
    source = null,
    setupData,
    setupShare = 0.15,
    vocabId = null,
    requireVocab = null,
    run,
  }) => {
    setStage('running');
    setRunError(null);
    stopRef.current = false;
    try {
      let setup = null;
      if (!setupDoneRef.current) {
        setup = await executeProjectSetup({
          client,
          isNewProject: true,
          resumeProjectId: projectIdRef.current,
          setupData: typeof setupData === 'function' ? setupData() : setupData,
          onProgress: (pct, msg) => setProgress({ label: msg, pct: pct * setupShare }),
          onProjectCreated: (id) => {
            projectIdRef.current = id;
            markImportStarted(client, id, kind, source);
          },
        });
        if (setup.failures.length > 0) throw new Error(setup.failures.join('. '));
        projectIdRef.current = setup.projectId;
        setupDoneRef.current = true;
      }
      const projectId = projectIdRef.current;
      const vocab = typeof vocabId === 'function' ? await vocabId({ projectId, setup }) : vocabId;
      await markImportStarted(client, projectId, kind, source, vocab);
      if (requireVocab && !vocab) throw new Error(requireVocab);

      const res = await run({
        projectId,
        vocabId: vocab,
        shouldStop: () => stopRef.current,
        setProgress,
      });
      if (!(await markImportFinished(client, projectId))) {
        notifyWarning(
          'The import record could not be cleared, so the project still opens this import.',
          'Import complete',
        );
      }
      setResults(res);
      setStage('done');
      const warnings = res.warnings?.length ?? 0;
      if (warnings) {
        notifyWarning(
          `Imported with ${warnings} warning${warnings === 1 ? '' : 's'}.`,
          'Import finished',
        );
      } else {
        notifySuccess(
          `Imported ${res.imported} document${res.imported === 1 ? '' : 's'}.`,
          'Import complete',
        );
      }
      return res;
    } catch (e) {
      console.error(`${kind} import failed:`, e);
      setRunError(e.message);
      setStage('review');
      if (!(e instanceof ImportCancelled) && e.message !== 'Import cancelled') {
        notifyError(e.message, 'Import failed');
      }
      return null;
    }
  };

  const stop = () => {
    stopRef.current = true;
  };

  return {
    stage,
    setStage,
    progress,
    setProgress,
    runError,
    results,
    projectIdRef,
    setupDoneRef,
    stop,
    start,
  };
}
