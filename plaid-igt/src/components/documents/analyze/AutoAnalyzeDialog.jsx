import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { TASKS } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { useServiceSpot } from '../hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress, formatElapsed } from '../hooks/useRunProgress.js';
import { ServiceRunDialog } from '../services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '../services/ServiceMethodRow.jsx';
import { runBuiltinAnalysis } from '@/domain/autoPass';
import { BUILTIN_LINK_PRECEDENT } from '@/domain/serviceDefaults';
import { resolveAutoAnalysis } from '@/domain/igtConfig';
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
    progressPercent,
    progressMessage,
  } = useServiceRequest();
  const [busy, setBusy] = useState(false);

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
    // Held for the whole run: four steps of writes with a reload after each.
    const release = acquireWriteLock('Auto-analyze');
    if (!release) return;
    setBusy(true);
    progress.start(plan.map((p) => p.label));
    const at = (key) => progress.step(plan.findIndex((p) => p.key === key));
    const info = doc.layerInfo;
    const parts = [];
    const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
    const identifiers = {
      documentId: doc.id,
      projectId: project.id,
      wordTokenLayerId: info.primaryTokenLayer?.id,
      morphemeTokenLayerId: info.morphemeTokenLayer?.id,
      sentenceTokenLayerId: info.sentenceTokenLayer?.id,
    };
    // A reload after each service step costs seconds on a large document and
    // shows nothing while it runs, so it gets its own line rather than a pause.
    const reload = async () => {
      progress.report({ percent: null, message: 'Loading results…' });
      await doc._reload();
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
            timeout: ANALYZE_TIMEOUT_MS,
          },
        );
        await reload();
        const n = result?.sentencesWritten ?? result?.sentences_written;
        if (typeof n === 'number') parts.push(`proposed translations for ${plural(n, 'sentence')}`);
      }
      // 2. copy previous analyses (built-in)
      if (steps.copy) {
        at('copy');
        const { copied, ok } = await runBuiltinAnalysis(doc, {
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
        });
        if (!ok) return; // the domain layer toasted the failure
        if (copied) parts.push(`copied previous analyses onto ${plural(copied, 'word')}`);
      }
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
            timeout: ANALYZE_TIMEOUT_MS,
          },
        );
        await reload();
        const n = result?.wordsWritten ?? result?.words_written;
        if (typeof n === 'number') parts.push(`proposed analyses for ${plural(n, 'word')}`);
        const prot = result?.skipped?.protected ?? 0;
        if (prot) parts.push(`left ${plural(prot, 'human-analyzed word')} alone`);
      }
      // 4. link to the lexicon
      if (linkOn) {
        at('link');
        if (linkSpot.isBuiltin) {
          const { linked, ok } = await runBuiltinAnalysis(doc, {
            link: true,
            copy: false,
            onProgress: progress.report,
          });
          if (!ok) return;
          if (linked)
            parts.push(
              `linked ${linked} word${linked === 1 ? '' : 's'}/morpheme${linked === 1 ? '' : 's'}`,
            );
        } else {
          const service = linkSpot.service;
          await requestService(
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
            },
          );
          await reload();
          parts.push('ran the linking service');
        }
      }
      const msg = parts.length
        ? `${parts.join(', ')}. Shown in violet until confirmed.`
        : 'Nothing new to apply.';
      notifySuccess(msg.charAt(0).toUpperCase() + msg.slice(1), 'Auto-analyze');
      onOpenChange(false);
    } catch (err) {
      // Service failures are toasted by the request hook; anything else here.
      console.error('Auto-analyze failed:', err);
      if (!isProcessing) notifyError('Auto-analyze failed. Try again.', 'Auto-analyze');
    } finally {
      progress.finish();
      setBusy(false);
      release();
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
