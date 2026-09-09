import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { TASKS } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError, notifyInfo, notifyWarning } from '@/utils/feedback';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { useServiceSpot } from '../hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress, formatElapsed } from '../hooks/useRunProgress.js';
import { ServiceRunDialog } from '../services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '../services/ServiceMethodRow.jsx';
import { runBuiltinAnalysis } from '@/domain/autoPass';
import { BUILTIN_LINK_PRECEDENT } from '@/domain/serviceDefaults';
import { resolveAutoAnalysis } from '@/domain/igtConfig';
import { writeRunRecord, clearRunRecord } from '@/domain/runRecord';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

const STEPS_STORAGE_KEY = 'plaid_igt_auto_analyze_steps';
// A whole-document model pass can take a few minutes on a large document.
const ANALYZE_TIMEOUT_MS = 20 * 60 * 1000;

const LINK_BUILTINS = [
  { name: BUILTIN_LINK_PRECEDENT, label: 'Built-in (precedent & unique matches)' },
];

// Auto-analyze: one dialog, four ordered steps, each toggleable, one Run.
//   1. translate — a service advertising the `translate` task fills the
//      sentence-scope translation field, first because the analyzers take
//      the free translation as input;
//   2. copy previous analyses (built-in analysis memory) — words that already
//      have an uncontested project-wide analysis get it copied, so the model
//      only sees what precedent can't answer;
//   3. propose segmentation + glosses — a service advertising the `analyze`
//      task (e.g. PolyGloss), over the whole document;
//   4. link to the lexicon — the built-in precedent-or-unique rule or a
//      `link-vocab` service, last so it can resolve the model's stems.
// Every step writes provenance-stamped material that renders violet until a
// person confirms it.
//
// This is the one composite in the app: four runs under one Run button. It
// wears the same shell as the single-spot dialogs (ServiceRunDialog), and each
// step's method is the same ServiceMethodRow the others use. What it adds is a
// step list in the status area, because a four-step run that reports one
// percentage cannot say which minute of the wait you are in.
// Opened by the island's toolbar button via the igt:auto-analyze-open event.
const readSteps = () => {
  try {
    return JSON.parse(localStorage.getItem(STEPS_STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

export const AutoAnalyzeDialog = ({ open, onOpenChange, doc, onRunStatus }) => {
  const project = doc?.project;
  const { writeLock, acquireWriteLock } = useDocumentCtx();
  const {
    availableServices,
    isDiscovering,
    discoverServices,
    isProcessing,
    requestService,
    cancelRequest,
    progressPercent,
    progressMessage,
  } = useServiceRequest();
  const [busy, setBusy] = useState(false);
  // Set by Stop, read at every step boundary and by the built-in phases'
  // checkpoints. Cleared when a run starts.
  const stopRef = useRef(false);
  // The run's lock handle, so Stop can say so on the banner from outside `run`.
  const lockRef = useRef(null);

  const autoCfg = resolveAutoAnalysis(project?.config);
  const hasVocabs = Object.keys(doc?.vocabularies || {}).length > 0;

  const translateSpot = useServiceSpot({
    task: TASKS.TRANSLATE,
    project,
    services: availableServices,
    storageId: 'translate',
  });
  const analyzeSpot = useServiceSpot({
    task: TASKS.ANALYZE,
    project,
    services: availableServices,
    storageId: 'analyze',
  });
  const linkSpot = useServiceSpot({
    task: TASKS.LINK_VOCAB,
    project,
    services: availableServices,
    builtins: LINK_BUILTINS,
    storageId: 'link_vocab',
  });

  const progress = useRunProgress();
  // Whatever service is running reports over the one channel; the step list
  // says which step that is.
  useMirroredProgress(progress, {
    percent: progressPercent,
    message: progressMessage,
    active: progress.running && isProcessing,
  });

  // One Stop for the whole run, whichever kind of step is in flight. Two of the
  // four steps are built-in and have no request to cancel, so a Stop wired only
  // to the service was a dead button for the slowest part of the run, and the
  // banner, which cannot see which step it is, showed it throughout.
  // Saying "Stopping…" here is the point: a checkpoint may be a document read
  // away, and nothing else would acknowledge the press.
  const report = progress.report;
  const stopRun = useCallback(async () => {
    stopRef.current = true;
    report({ percent: null, message: 'Stopping…' });
    lockRef.current?.setStatus('Stopping…');
    await cancelRequest();
  }, [cancelRequest, report]);

  // Step toggles: remembered per user; the copy step's default comes from the
  // project's built-in-analysis settings, the model step defaults on whenever
  // a service is online, linking defaults on when the project has a lexicon.
  const [steps, setSteps] = useState({ translate: true, copy: true, analyze: true, link: true });
  useEffect(() => {
    if (!open) return;
    const saved = readSteps();
    setSteps({
      translate: saved.translate ?? true,
      copy: saved.copy ?? autoCfg.copyAnalyses,
      analyze: saved.analyze ?? true,
      link: saved.link ?? true,
    });
    if (project?.id) discoverServices(project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);
  const toggleStep = (key, on) => {
    const next = { ...steps, [key]: on };
    setSteps(next);
    try {
      localStorage.setItem(STEPS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const running = busy || isProcessing;
  const translateOn = steps.translate && !!translateSpot.service;
  const analyzeOn = steps.analyze && !!analyzeSpot.service;
  const linkOn = steps.link && hasVocabs;
  const nothingToRun = !translateOn && !steps.copy && !analyzeOn && !linkOn;

  // The steps this Run will actually take, in order — the same list the status
  // area ticks through, so what is promised and what is reported cannot drift.
  const plan = useMemo(() => {
    const out = [];
    if (translateOn) out.push({ key: 'translate', label: 'Propose translations' });
    if (steps.copy) out.push({ key: 'copy', label: 'Copy previous analyses' });
    if (analyzeOn) out.push({ key: 'analyze', label: 'Propose segmentation and glosses' });
    if (linkOn) out.push({ key: 'link', label: 'Link to the lexicon' });
    return out;
  }, [translateOn, steps.copy, analyzeOn, linkOn]);

  const blockingErrors = useMemo(() => {
    const out = [];
    if (translateOn) out.push(...Object.values(translateSpot.params.errors));
    if (analyzeOn) out.push(...Object.values(analyzeSpot.params.errors));
    if (linkOn && linkSpot.service) out.push(...Object.values(linkSpot.params.errors));
    return out;
  }, [translateOn, translateSpot, analyzeOn, analyzeSpot, linkOn, linkSpot]);

  const run = async () => {
    if (running || !doc || nothingToRun) return;
    if (blockingErrors.length) {
      notifyError(blockingErrors[0], 'Missing required option');
      return;
    }
    stopRef.current = false;
    // Held for the whole run: four steps of writes with a reload after each.
    const lock = acquireWriteLock('Auto-analyze', { onCancel: stopRun });
    if (!lock) return;
    lockRef.current = lock;
    setBusy(true);
    progress.start(plan.map((p) => p.label));
    const at = (key) => {
      const i = plan.findIndex((p) => p.key === key);
      progress.step(i);
      lock.setStatus(`Step ${i + 1} of ${plan.length}. ${plan[i].label}.`);
    };
    // Only the step in flight can be rejoined: the ordering happens here, in
    // the browser, so `multiStep` tells the resume to say the rest did not run.
    const recordStep = (requestId) =>
      writeRunRecord(doc.id, {
        requestId,
        projectId: project.id,
        label: 'Auto-analyze',
        multiStep: true,
      });
    const info = doc.layerInfo;
    let stillOut = false; // the request survived our giving up on it
    // Whether anything actually landed. A run where every sentence failed still
    // comes back `status: success` with counts of zero, and telling someone
    // their document is "shown in violet until confirmed" when nothing was
    // written is worse than saying plainly that nothing was.
    let wrote = false;
    const parts = [];
    // What a service could not do. Services report per-sentence failures in the
    // result rather than failing the request, so this is the only place it can
    // be said.
    const noteFailures = (result, verb) => {
      const failed = result?.sentencesFailed?.length ?? 0;
      if (failed) parts.push(`could not ${verb} ${plural(failed, 'sentence')}`);
    };
    const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
    const identifiers = {
      documentId: doc.id,
      projectId: project.id,
      wordTokenLayerId: info.primaryTokenLayer?.id,
      morphemeTokenLayerId: info.morphemeTokenLayer?.id,
      sentenceTokenLayerId: info.sentenceTokenLayer?.id,
    };
    // A stopped step ends the RUN, not just the step: the person asked for it
    // to stop, so the steps after it must not quietly go ahead. The request
    // hook has already said so, hence no toast of our own.
    const stopped = (result) => result?.stopped === true;
    // A stop noticed anywhere else has nobody else to report it: a built-in
    // step's checkpoint, or between steps while a reload was in flight.
    const halt = () => notifyInfo('Stopped. What it had already written stays.', 'Auto-analyze');
    // A reload after each service step costs seconds on a large document and
    // shows nothing while it runs, so it gets its own line rather than a pause.
    const reload = async () => {
      progress.report({ percent: null, message: 'Loading results…' });
      lock.setStatus('Loading results…');
      await doc._reload();
      // The step is done and collected; nothing left for a reload to rejoin.
      clearRunRecord(doc.id);
    };
    try {
      // 1. translate (service)
      if (translateOn) {
        at('translate');
        const service = translateSpot.service;
        const result = await requestService(
          project.id,
          doc.id,
          service.serviceId,
          { ...translateSpot.params.coerced(), ...identifiers },
          {
            successTitle: 'Translation complete',
            successMessage: `${service.serviceName} finished.`,
            errorTitle: 'Translation failed',
            errorMessage: `${service.serviceName} reported an error.`,
            stoppedTitle: 'Auto-analyze',
            onRequestId: recordStep,
            timeout: ANALYZE_TIMEOUT_MS,
          },
        );
        if (stopped(result)) return;
        await reload();
        const n = result?.sentencesWritten ?? result?.sentences_written;
        if (n > 0) {
          parts.push(`proposed translations for ${plural(n, 'sentence')}`);
          wrote = true;
        }
        noteFailures(result, 'translate');
      }
      if (stopRef.current) return halt();
      // 2. copy previous analyses (built-in)
      if (steps.copy) {
        at('copy');
        const {
          copied,
          ok,
          stopped: wasStopped,
        } = await runBuiltinAnalysis(doc, {
          link: false,
          copy: true,
          copyContents: {
            segmentation: autoCfg.copySegmentation,
            links: autoCfg.copyLinks,
            fields: autoCfg.copyFields,
          },
          // Reading precedent means fetching other documents one at a time —
          // the slowest built-in step, and the one that used to look stalled.
          onProgress: progress.report,
          shouldStop: () => stopRef.current,
        });
        if (!ok) return; // the domain layer toasted the failure
        if (wasStopped) return halt();
        if (copied) {
          parts.push(`copied previous analyses onto ${plural(copied, 'word')}`);
          wrote = true;
        }
      }
      if (stopRef.current) return halt();
      // 3. propose segmentation + glosses (service)
      if (analyzeOn) {
        at('analyze');
        const service = analyzeSpot.service;
        const result = await requestService(
          project.id,
          doc.id,
          service.serviceId,
          // User-controlled args first; the fixed identifiers win.
          { ...analyzeSpot.params.coerced(), ...identifiers },
          {
            successTitle: 'Analysis complete',
            successMessage: `${service.serviceName} finished.`,
            errorTitle: 'Analysis failed',
            errorMessage: `${service.serviceName} reported an error.`,
            stoppedTitle: 'Auto-analyze',
            onRequestId: recordStep,
            timeout: ANALYZE_TIMEOUT_MS,
          },
        );
        if (stopped(result)) return;
        await reload();
        const n = result?.wordsWritten ?? result?.words_written;
        if (n > 0) {
          parts.push(`proposed analyses for ${plural(n, 'word')}`);
          wrote = true;
        }
        const prot = result?.skipped?.protected ?? 0;
        if (prot) parts.push(`left ${plural(prot, 'human-analyzed word')} alone`);
        noteFailures(result, 'analyze');
      }
      if (stopRef.current) return halt();
      // 4. link to the lexicon
      if (linkOn) {
        at('link');
        if (linkSpot.isBuiltin) {
          const {
            linked,
            ok,
            stopped: wasStopped,
          } = await runBuiltinAnalysis(doc, {
            link: true,
            copy: false,
            onProgress: progress.report,
            shouldStop: () => stopRef.current,
          });
          if (!ok) return;
          if (wasStopped) return halt();
          if (linked) {
            parts.push(
              `linked ${linked} word${linked === 1 ? '' : 's'}/morpheme${linked === 1 ? '' : 's'}`,
            );
            wrote = true;
          }
        } else {
          const service = linkSpot.service;
          const result = await requestService(
            project.id,
            doc.id,
            service.serviceId,
            {
              ...linkSpot.params.coerced(),
              ...identifiers,
              vocabIds: Object.keys(doc.vocabularies || {}),
            },
            {
              successTitle: 'Linking complete',
              successMessage: `${service.serviceName} finished.`,
              errorTitle: 'Linking failed',
              errorMessage: `${service.serviceName} reported an error.`,
              stoppedTitle: 'Auto-analyze',
              onRequestId: recordStep,
            },
          );
          if (stopped(result)) return;
          await reload();
          parts.push('ran the linking service');
          wrote = true;
        }
      }
      // The violet line is a promise about material on screen, so it is only
      // made when something was written.
      const msg = parts.length
        ? `${parts.join(', ')}.${wrote ? ' Shown in violet until confirmed.' : ''}`
        : 'Nothing new to apply.';
      const say = wrote ? notifySuccess : notifyWarning;
      say(msg.charAt(0).toUpperCase() + msg.slice(1), 'Auto-analyze');
      onOpenChange(false);
    } catch (err) {
      // Service failures are toasted by the request hook; anything else here.
      console.error('Auto-analyze failed:', err);
      // `pending` means the request is still out there. The client stopped
      // waiting, the service did not stop working, so keep the record and let a
      // reload rejoin it instead of losing the run.
      stillOut = err?.pending === true;
      // Only what the request hook has NOT already reported. This used to read
      // `isProcessing`, which the closure fixes at false for the whole run, so
      // every service failure was toasted twice: once by its own name, and
      // again as "Auto-analyze failed".
      if (!err?.reported) notifyError('Auto-analyze failed. Try again.', 'Auto-analyze');
    } finally {
      if (!stillOut) clearRunRecord(doc.id);
      progress.finish();
      setBusy(false);
      lock.release();
      lockRef.current = null;
    }
  };

  // The island's toolbar button is the opener here, so it is where the run
  // shows once the dialog is shut. Same contract as ServiceRunButton.
  useEffect(() => {
    if (!onRunStatus) return;
    onRunStatus(
      progress.running
        ? {
            running: true,
            label: `${formatElapsed(progress.elapsedMs)}${
              Number.isFinite(progress.percent) ? `, ${Math.round(progress.percent)}%` : ''
            }`,
          }
        : null,
    );
  }, [onRunStatus, progress.running, progress.elapsedMs, progress.percent]);

  const serviceHint = (spot, absent) =>
    spot.service ? null : isDiscovering ? 'Discovering services…' : absent;

  return (
    <ServiceRunDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Auto-analyze"
      icon={Sparkles}
      progress={progress}
      runLabel="Run"
      onRun={run}
      // Stops the step in flight; the steps after it do not run.
      onCancel={stopRun}
      runDisabled={nothingToRun || blockingErrors.length > 0 || (!!writeLock && !running)}
    >
      <Step
        n={1}
        stepKey="translate"
        label="Propose translations"
        on={steps.translate}
        disabled={!translateSpot.service}
        running={running}
        onToggle={toggleStep}
        hint={
          serviceHint(translateSpot, 'No translation service is online.') ??
          'A model drafts a free translation for every sentence, from the words and any glosses. Translations a person wrote are left alone; earlier machine drafts are refreshed.'
        }
      >
        {steps.translate && translateSpot.service && (
          <ServiceMethodRow spot={translateSpot} disabled={running} />
        )}
      </Step>

      <Step
        n={2}
        stepKey="copy"
        label="Copy previous analyses"
        on={steps.copy}
        running={running}
        onToggle={toggleStep}
        hint="Words with an uncontested analysis elsewhere in the project get it copied: segmentation, links, and field values. Only words with no analysis at all are touched."
      />

      <Step
        n={3}
        stepKey="analyze"
        label="Propose segmentation and glosses"
        on={steps.analyze}
        disabled={!analyzeSpot.service}
        running={running}
        onToggle={toggleStep}
        hint={
          serviceHint(analyzeSpot, 'No analysis service is online.') ??
          'A model analyzes every sentence. Words a person analyzed are left alone; earlier machine proposals are refreshed.'
        }
      >
        {steps.analyze && analyzeSpot.service && (
          <ServiceMethodRow spot={analyzeSpot} disabled={running} />
        )}
      </Step>

      <Step
        n={4}
        stepKey="link"
        label="Link to the lexicon"
        on={steps.link}
        disabled={!hasVocabs}
        running={running}
        onToggle={toggleStep}
        hint={
          hasVocabs
            ? 'Links words and morphemes to lexicon entries. Human-made and confirmed links are left alone.'
            : 'This project has no lexicon.'
        }
      >
        {steps.link && hasVocabs && <ServiceMethodRow spot={linkSpot} disabled={running} />}
      </Step>
    </ServiceRunDialog>
  );
};

// One numbered, toggleable step: the checkbox and its hint, with the step's
// method indented underneath when it has one.
const Step = ({ n, stepKey, label, on, disabled, running, onToggle, hint, children }) => (
  <section className="flex flex-col gap-2">
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-primary"
        checked={on}
        disabled={disabled || running}
        onChange={(e) => onToggle(stepKey, e.target.checked)}
        aria-label={label}
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium">
          {n}. {label}
        </span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
    {children && <div className="ml-6">{children}</div>}
  </section>
);
