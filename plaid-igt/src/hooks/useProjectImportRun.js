import { useRef, useState } from 'react';
import { executeProjectSetup } from '@/components/projects/setup/executeSetup';
import { markImportStarted } from '@/domain/igtConfig';
import { finishImport } from '@/domain/importFinish';
import { ImportCancelled } from '@/import/stamps';
import { notifyError, notifySuccess, notifyWarning, humanizeError } from '@/utils/feedback';
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

// The run of a project import, shared by the four wizards that make a project
// from a file (FLEx, CLDF, ELAN, the archive). A wizard reads its file, shows
// a review, and then calls `start` with what differs: the setup-wizard input
// its file implies and the engine call. Everything around that is the same
// for all of them and lives here: the stages, the progress bar, the stop
// flag, the import record on the project, and the finished-and-warnings
// toasts.
//
// The record goes on the project the moment it exists and is removed once
// the whole run is over, so a run that stops, fails or is closed leaves a
// project that does not open (`readImportState`). Such a project is never
// finished: `unfinished` names it, and the screen offers to delete it
// (`clearUnfinished` once it is gone), after which `start` makes a new one.
//
//   client, kind:  the app client and the record's kind ("FLEx")
//   start({ source, setupData, setupShare, vocabId, requireVocab, run })
//     source:       what the record names as the file (or null)
//     setupData:    the setup-wizard input, or a function that makes it
//     setupShare:   how much of the bar setup takes, 0.15 unless said
//     vocabId:      the lexicon the run writes into: an id, null, or an async
//                   function of { projectId, setup }
//     requireVocab: the error to raise when no lexicon could be found
//     run:          ({ projectId, vocabId, shouldStop, setProgress }) => the
//                   engine's result, with `imported` and maybe `warnings`
export function useProjectImportRun({ client, kind }) {
  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  const [progress, setProgress] = useState(null); // {label, pct} | null
  const [runError, setRunError] = useState(null);
  // Whether that error was the Stop button rather than a failure. The run
  // knows; the screen must not have to guess it from the wording.
  const [stopped, setStopped] = useState(false);
  const [results, setResults] = useState(null);
  // The project the run made: the one to open once it is done, and the one
  // left unfinished when it stops.
  const projectIdRef = useRef(null);
  const [unfinished, setUnfinished] = useState(null); // {id, name} | null
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
    setStopped(false);
    setUnfinished(null);
    stopRef.current = false;
    projectIdRef.current = null;
    const data = typeof setupData === 'function' ? setupData() : setupData;
    try {
      const setup = await executeProjectSetup({
        client,
        isNewProject: true,
        resumeProjectId: null,
        setupData: data,
        onProgress: (pct, msg) => setProgress({ label: msg, pct: pct * setupShare }),
        onProjectCreated: async (id) => {
          projectIdRef.current = id;
          await markImportStarted(client, id, kind, source);
        },
      });
      if (setup.failures.length > 0) throw new Error(setup.failures.join('. '));
      const projectId = setup.projectId;
      projectIdRef.current = projectId;
      const vocab = typeof vocabId === 'function' ? await vocabId({ projectId, setup }) : vocabId;
      if (requireVocab && !vocab) throw new Error(requireVocab);

      const ran = await run({
        projectId,
        vocabId: vocab,
        shouldStop: () => stopRef.current,
        setProgress,
      });
      const finished = await finishImport(client, projectId);
      if (!finished.cleared) throw new Error('The import could not be recorded as finished.');
      const said = new Set(ran?.warnings || []);
      const more = finished.warnings.filter((w) => !said.has(w));
      const res = more.length ? { ...ran, warnings: [...(ran?.warnings || []), ...more] } : ran;
      setResults(res);
      setStage('done');
      const warnings = res.warnings?.length ?? 0;
      if (warnings) {
        notifyWarning(`Imported with ${countOf(warnings, 'warning')}.`, 'Import finished');
      } else {
        notifySuccess(`Imported ${countOf(res.imported, 'document')}.`, 'Import complete');
      }
      return res;
    } catch (e) {
      const cancelled = e instanceof ImportCancelled;
      if (!cancelled) console.error(`${kind} import failed:`, e);
      setRunError(humanizeError(e));
      setStopped(cancelled);
      if (projectIdRef.current) {
        setUnfinished({ id: projectIdRef.current, name: data?.basicInfo?.projectName ?? null });
      }
      setStage('review');
      if (!cancelled) notifyError(humanizeError(e), 'Failed to import');
      return null;
    }
  };

  const stop = () => {
    stopRef.current = true;
  };

  // The unfinished project is gone: the next `start` makes a new one.
  const clearUnfinished = () => {
    projectIdRef.current = null;
    setUnfinished(null);
    setRunError(null);
    setStopped(false);
  };

  return {
    stage,
    setStage,
    progress,
    setProgress,
    runError,
    stopped,
    results,
    projectIdRef,
    unfinished,
    clearUnfinished,
    stop,
    start,
  };
}
