import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { TASKS, filterServicesByTask } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { useServiceParams } from '../hooks/useServiceParams.js';
import { ServiceSummary } from '../services/ServiceSummary.jsx';
import { ServiceParamForm } from '../services/ServiceParamForm.jsx';
import { runBuiltinAnalysis } from '@/domain/autoPass';
import {
  BUILTIN_LINK_PRECEDENT,
  encodeServiceSelection,
  encodeBuiltinSelection,
  readSpotDefault,
  resolveInitialSelection,
} from '@/domain/serviceDefaults';
import { resolveAutoAnalysis } from '@/domain/igtConfig';

const BUILTIN_LINK = encodeBuiltinSelection(BUILTIN_LINK_PRECEDENT);
const LINK_STORAGE_KEY = 'plaid_igt_link_vocab_service';
const LINK_PARAMS_PREFIX = 'plaid_igt_link_vocab_params_';
const ANALYZE_STORAGE_KEY = 'plaid_igt_analyze_service';
const ANALYZE_PARAMS_PREFIX = 'plaid_igt_analyze_params_';
const STEPS_STORAGE_KEY = 'plaid_igt_auto_analyze_steps';
// A whole-document model pass can take a few minutes on a large document.
const ANALYZE_TIMEOUT_MS = 20 * 60 * 1000;

// Auto-analyze: one dialog, three ordered steps, each toggleable, one Run.
//   1. copy previous analyses (built-in analysis memory) — words that already
//      have an uncontested project-wide analysis get it copied, so the model
//      only sees what precedent can't answer;
//   2. propose segmentation + glosses — a service advertising the `analyze`
//      task (e.g. PolyGloss), over the whole document;
//   3. link to the lexicon — the built-in precedent-or-unique rule or a
//      `link-vocab` service, last so it can resolve the model's stems.
// Every step writes provenance-stamped material that renders violet until a
// person confirms it. Service steps use the same selection idiom as the
// Media/Tokenize tabs (discovery, summary, declared parameter form, progress;
// initial choice resolves localStorage → project default → built-in/first
// online). Opened by the island's toolbar button via the
// igt:auto-analyze-open window event.
const readSteps = () => {
  try {
    return JSON.parse(localStorage.getItem(STEPS_STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

export const AutoAnalyzeDialog = ({ open, onOpenChange, doc }) => {
  const project = doc?.project;
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
  const [phase, setPhase] = useState(null); // 'copy' | 'analyze' | 'link' while running
  const [linkChoice, setLinkChoice] = useState(null);
  const [analyzeChoice, setAnalyzeChoice] = useState(null);

  const autoCfg = resolveAutoAnalysis(project?.config);
  const hasVocabs = Object.keys(doc?.vocabularies || {}).length > 0;

  // Only ONLINE services can take work (discovery also returns
  // previously-seen offline services).
  const online = (task) =>
    filterServicesByTask(availableServices, task).filter((s) => s.online !== false);
  const analyzeServices = online(TASKS.ANALYZE);
  const linkServices = online(TASKS.LINK_VOCAB);

  // Step toggles: remembered per user; the copy step's default comes from the
  // project's built-in-analysis settings, the model step defaults on whenever
  // a service is online, linking defaults on when the project has a lexicon.
  const [steps, setSteps] = useState({ copy: true, analyze: true, link: true });
  useEffect(() => {
    if (!open) return;
    const saved = readSteps();
    setSteps({
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

  // --- step 2: analysis service ---
  const analyzeOptions = analyzeServices.map((s) => ({
    value: encodeServiceSelection(s.serviceId),
    label: s.serviceName,
    service: s,
  }));
  const analyzeResolved = resolveInitialSelection({
    services: analyzeServices,
    builtins: [],
    cached: localStorage.getItem(ANALYZE_STORAGE_KEY),
    projectDefault: readSpotDefault(project, TASKS.ANALYZE),
  });
  const analyzeSel = analyzeChoice ?? analyzeResolved;
  const analyzeEffective = analyzeOptions.some((o) => o.value === analyzeSel)
    ? analyzeSel
    : (analyzeOptions[0]?.value ?? null);
  const analyzeService = analyzeOptions.find((o) => o.value === analyzeEffective)?.service ?? null;
  const analyzeDefault = readSpotDefault(project, TASKS.ANALYZE);
  const analyzeParams = useServiceParams(
    analyzeService,
    ANALYZE_PARAMS_PREFIX,
    analyzeDefault?.service?.serviceId === analyzeService?.serviceId
      ? analyzeDefault?.params
      : null,
  );
  const chooseAnalyze = (v) => {
    setAnalyzeChoice(v);
    localStorage.setItem(ANALYZE_STORAGE_KEY, v);
  };

  // --- step 3: linking method ---
  const linkOptions = [
    { value: BUILTIN_LINK, label: 'Built-in (precedent & unique matches)' },
    ...linkServices.map((s) => ({
      value: encodeServiceSelection(s.serviceId),
      label: s.serviceName,
      service: s,
    })),
  ];
  const linkResolved =
    resolveInitialSelection({
      services: linkServices,
      builtins: [BUILTIN_LINK_PRECEDENT],
      cached: localStorage.getItem(LINK_STORAGE_KEY),
      projectDefault: readSpotDefault(project, TASKS.LINK_VOCAB),
    }) || BUILTIN_LINK;
  const linkSel = linkChoice ?? linkResolved;
  const linkEffective = linkOptions.some((o) => o.value === linkSel) ? linkSel : BUILTIN_LINK;
  const linkService = linkOptions.find((o) => o.value === linkEffective)?.service ?? null;
  const linkDefault = readSpotDefault(project, TASKS.LINK_VOCAB);
  const linkParams = useServiceParams(
    linkService,
    LINK_PARAMS_PREFIX,
    linkDefault?.service?.serviceId === linkService?.serviceId ? linkDefault?.params : null,
  );
  const chooseLink = (v) => {
    setLinkChoice(v);
    localStorage.setItem(LINK_STORAGE_KEY, v);
  };

  const running = busy || isProcessing;
  const analyzeOn = steps.analyze && !!analyzeService;
  const linkOn = steps.link && hasVocabs;
  const nothingToRun = !steps.copy && !analyzeOn && !linkOn;
  const blockingErrors = useMemo(() => {
    const out = [];
    if (analyzeOn) out.push(...Object.values(analyzeParams.errors || {}));
    if (linkOn && linkService) out.push(...Object.values(linkParams.errors || {}));
    return out;
  }, [analyzeOn, analyzeParams.errors, linkOn, linkService, linkParams.errors]);

  const run = async () => {
    if (running || !doc || nothingToRun) return;
    if (blockingErrors.length) {
      notifyError(blockingErrors[0], 'Missing required option');
      return;
    }
    setBusy(true);
    const info = doc.layerInfo;
    const parts = [];
    const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
    try {
      // 1. copy previous analyses (built-in)
      if (steps.copy) {
        setPhase('copy');
        const { copied, ok } = await runBuiltinAnalysis(doc, {
          link: false,
          copy: true,
          copyContents: {
            segmentation: autoCfg.copySegmentation,
            links: autoCfg.copyLinks,
            fields: autoCfg.copyFields,
          },
        });
        if (!ok) return; // the domain layer toasted the failure
        if (copied) parts.push(`copied previous analyses onto ${plural(copied, 'word')}`);
      }
      // 2. propose segmentation + glosses (service)
      if (analyzeOn) {
        setPhase('analyze');
        const result = await requestService(
          project.id,
          doc.id,
          analyzeService.serviceId,
          {
            // User-controlled args first; the fixed identifiers below win.
            ...analyzeParams.coerced(),
            documentId: doc.id,
            projectId: project.id,
            wordTokenLayerId: info.primaryTokenLayer?.id,
            morphemeTokenLayerId: info.morphemeTokenLayer?.id,
            sentenceTokenLayerId: info.sentenceTokenLayer?.id,
          },
          {
            successTitle: 'Analysis complete',
            successMessage: `${analyzeService.serviceName} finished.`,
            errorTitle: 'Analysis failed',
            errorMessage: `${analyzeService.serviceName} reported an error.`,
            timeout: ANALYZE_TIMEOUT_MS,
          },
        );
        await doc._reload();
        const n = result?.wordsWritten ?? result?.words_written;
        if (typeof n === 'number') parts.push(`proposed analyses for ${plural(n, 'word')}`);
        const skipped = result?.skipped || {};
        const prot = skipped.protected ?? 0;
        if (prot) parts.push(`left ${plural(prot, 'human-analyzed word')} alone`);
      }
      // 3. link to the lexicon
      if (linkOn) {
        setPhase('link');
        if (linkEffective === BUILTIN_LINK) {
          const { linked, ok } = await runBuiltinAnalysis(doc, { link: true, copy: false });
          if (!ok) return;
          if (linked)
            parts.push(
              `linked ${linked} word${linked === 1 ? '' : 's'}/morpheme${linked === 1 ? '' : 's'}`,
            );
        } else {
          await requestService(
            project.id,
            doc.id,
            linkService.serviceId,
            {
              ...linkParams.coerced(),
              documentId: doc.id,
              projectId: project.id,
              vocabIds: Object.keys(doc.vocabularies || {}),
              wordTokenLayerId: info.primaryTokenLayer?.id,
              morphemeTokenLayerId: info.morphemeTokenLayer?.id,
            },
            {
              successTitle: 'Linking complete',
              successMessage: `${linkService.serviceName} finished.`,
              errorTitle: 'Linking failed',
              errorMessage: `${linkService.serviceName} reported an error.`,
            },
          );
          await doc._reload();
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
      setPhase(null);
      setBusy(false);
    }
  };

  const StepHeader = ({ n, stepKey, label, on, disabled, hint }) => (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-primary"
        checked={on}
        disabled={disabled || running}
        onChange={(e) => toggleStep(stepKey, e.target.checked)}
        aria-label={label}
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium">
          {n}. {label}
        </span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!running) onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Auto-analyze
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* 1. copy */}
          <section className="flex flex-col gap-1.5">
            <StepHeader
              n={1}
              stepKey="copy"
              label="Copy previous analyses"
              on={steps.copy}
              hint="Words with an uncontested analysis elsewhere in the project get it copied: segmentation, links, and field values. Only words with no analysis at all are touched."
            />
          </section>

          {/* 2. analyze */}
          <section className="flex flex-col gap-2">
            <StepHeader
              n={2}
              stepKey="analyze"
              label="Propose segmentation and glosses"
              on={steps.analyze}
              disabled={!analyzeService}
              hint={
                analyzeService
                  ? 'A model analyzes every sentence. Words a person analyzed are left alone; earlier machine proposals are refreshed.'
                  : isDiscovering
                    ? 'Discovering services…'
                    : 'No analysis service is online.'
              }
            />
            {steps.analyze && analyzeService && (
              <div className="ml-6 flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs">Service</Label>
                  <ServiceSummary service={analyzeService} />
                </div>
                <Select value={analyzeEffective} onValueChange={chooseAnalyze} disabled={running}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {analyzeOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {analyzeParams.schema?.length > 0 && (
                  <ServiceParamForm
                    schema={analyzeParams.schema}
                    values={analyzeParams.values}
                    errors={analyzeParams.errors}
                    onChange={analyzeParams.setParam}
                    disabled={running}
                  />
                )}
              </div>
            )}
          </section>

          {/* 3. link */}
          <section className="flex flex-col gap-2">
            <StepHeader
              n={3}
              stepKey="link"
              label="Link to the lexicon"
              on={steps.link}
              disabled={!hasVocabs}
              hint={
                hasVocabs
                  ? 'Links words and morphemes to lexicon entries. Human-made and confirmed links are left alone.'
                  : 'This project has no lexicon.'
              }
            />
            {steps.link && hasVocabs && (
              <div className="ml-6 flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs">Method</Label>
                  {linkService && <ServiceSummary service={linkService} />}
                </div>
                <Select value={linkEffective} onValueChange={chooseLink} disabled={running}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {linkOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {linkService && linkParams.schema?.length > 0 && (
                  <ServiceParamForm
                    schema={linkParams.schema}
                    values={linkParams.values}
                    errors={linkParams.errors}
                    onChange={linkParams.setParam}
                    disabled={running}
                  />
                )}
              </div>
            )}
          </section>

          {running && (
            <div className="flex flex-col gap-2">
              {isProcessing && (
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progressPercent || 0}%` }}
                  />
                </div>
              )}
              <span className="text-sm text-muted-foreground" role="status">
                {phase === 'copy' && 'Copying previous analyses…'}
                {phase === 'analyze' && (progressMessage || 'Analyzing…')}
                {phase === 'link' && (isProcessing ? progressMessage || 'Linking…' : 'Linking…')}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={run} disabled={running || nothingToRun || blockingErrors.length > 0}>
            {running ? 'Running…' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
