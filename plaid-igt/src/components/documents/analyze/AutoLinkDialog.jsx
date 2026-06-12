import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { TASKS, filterServicesByTask } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { useServiceParams } from '../hooks/useServiceParams.js';
import { ServiceSummary } from '../services/ServiceSummary.jsx';
import { ServiceParamForm } from '../services/ServiceParamForm.jsx';
import {
  AUTO_LINK_SOURCE, precedentQueries, buildPrecedentTable, computeAutoLinkProposals,
} from '@/domain/autoLink';
import {
  BUILTIN_LINK_PRECEDENT, encodeServiceSelection, encodeBuiltinSelection,
  readSpotDefault, resolveInitialSelection,
} from '@/domain/serviceDefaults';

const BUILTIN = encodeBuiltinSelection(BUILTIN_LINK_PRECEDENT);
const STORAGE_KEY = 'plaid_igt_link_vocab_service';
const PARAMS_PREFIX = 'plaid_igt_link_vocab_params_';

// Auto-link modal: pick an algorithm — the built-in precedent-or-unique rule
// or any registered service advertising the link-vocab task — and run it over
// the current document. Same service-selection idiom as the Media/Tokenize
// tabs (discovery, summary, declared parameter form, progress; initial choice
// resolves localStorage -> project default -> built-in). Opened by the
// island's toolbar button via the igt:auto-link-open window event.
export const AutoLinkDialog = ({ open, onOpenChange, doc }) => {
  const project = doc?.project;
  const {
    availableServices, isDiscovering, discoverServices,
    isProcessing, requestService, progressPercent, progressMessage,
  } = useServiceRequest();
  const [algorithm, setAlgorithm] = useState(null);
  const [busy, setBusy] = useState(false);

  // (Re)discover services each time the dialog opens.
  useEffect(() => {
    if (open && project?.id) discoverServices(project.id);
  }, [open, project?.id, discoverServices]);

  // Only ONLINE services can take work (discovery also returns
  // previously-seen offline services).
  const onlineServices = filterServicesByTask(availableServices, TASKS.LINK_VOCAB)
    .filter((s) => s.online !== false);
  const serviceOptions = onlineServices
    .map((s) => ({ value: encodeServiceSelection(s.serviceId), label: s.serviceName, service: s }));
  const options = [
    { value: BUILTIN, label: 'Built-in — follow precedent & unique matches' },
    ...serviceOptions,
  ];
  // Resolve until the user explicitly picks: cached -> project default ->
  // built-in. Also covers a cached service that has vanished.
  const resolved = resolveInitialSelection({
    services: onlineServices,
    builtins: [BUILTIN_LINK_PRECEDENT],
    cached: localStorage.getItem(STORAGE_KEY),
    projectDefault: readSpotDefault(project, TASKS.LINK_VOCAB),
  }) || BUILTIN;
  const chosen = algorithm ?? resolved;
  const effective = options.some((o) => o.value === chosen) ? chosen : BUILTIN;
  const selectedService = serviceOptions.find((o) => o.value === effective)?.service ?? null;
  const linkDefault = readSpotDefault(project, TASKS.LINK_VOCAB);
  const { schema: paramSchema, values: paramValues, setParam: setParamValue, coerced: coerceParams, errors: paramErrors } =
    useServiceParams(selectedService, PARAMS_PREFIX,
      linkDefault?.service?.serviceId === selectedService?.serviceId ? linkDefault?.params : null);

  const choose = (v) => {
    setAlgorithm(v);
    localStorage.setItem(STORAGE_KEY, v);
  };

  const running = busy || isProcessing;

  const run = async () => {
    if (running || !doc) return;
    setBusy(true);
    try {
      if (effective === BUILTIN) {
        const vocabIds = Object.keys(doc.vocabularies || {});
        const results = await Promise.all(
          precedentQueries(vocabIds).map((q) => doc._client.query(q)));
        const precedentTable = buildPrecedentTable(results);
        const proposals = computeAutoLinkProposals({
          sentences: doc.sentences,
          vocabularies: doc.vocabularies,
          precedentTable,
        });
        const n = proposals.length ? await doc.bulkLinkVocab(proposals, AUTO_LINK_SOURCE) : 0;
        if (n === false) return; // the domain layer toasted the failure
        notifySuccess(
          n > 0 ? `Linked ${n} word${n === 1 ? '' : 's'}/morpheme${n === 1 ? '' : 's'} — shown in violet until confirmed.` : 'Nothing new to link.',
          'Auto-link'
        );
        onOpenChange(false);
      } else {
        const missing = Object.values(paramErrors || {});
        if (missing.length) {
          notifyError(missing[0], 'Missing required option');
          return;
        }
        const info = doc.layerInfo;
        await requestService(
          project.id,
          doc.id,
          selectedService.serviceId,
          {
            // User-controlled args first; the fixed identifiers below win.
            ...coerceParams(),
            documentId: doc.id,
            projectId: project.id,
            vocabIds: Object.keys(doc.vocabularies || {}),
            wordTokenLayerId: info.primaryTokenLayer?.id,
            morphemeTokenLayerId: info.morphemeTokenLayer?.id,
          },
          {
            successTitle: 'Auto-link Complete',
            successMessage: 'The linking service finished.',
            errorTitle: 'Auto-link Failed',
            errorMessage: 'The linking service reported an error.',
          }
        );
        await doc._reload();
        onOpenChange(false);
      }
    } catch (err) {
      console.error('Auto-link failed:', err);
      notifyError('Auto-link failed — try again.', 'Auto-link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Auto-link to lexicon
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Label>Method</Label>
              {selectedService && <ServiceSummary service={selectedService} />}
              {isDiscovering && <span className="text-xs text-muted-foreground">discovering services…</span>}
            </div>
            <Select value={effective} onValueChange={choose} disabled={running}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {effective === BUILTIN ? (
            <p className="text-sm text-muted-foreground">
              Links every unlinked word and morpheme whose form follows the
              project's existing links (strict majority) or matches exactly one
              lexicon entry. Ambiguous forms are skipped. New links show in
              violet until you confirm them.
            </p>
          ) : (
            paramSchema?.length > 0 && (
              <ServiceParamForm
                schema={paramSchema}
                values={paramValues}
                errors={paramErrors}
                onChange={setParamValue}
                disabled={running}
              />
            )
          )}

          {isProcessing && (
            <div className="flex flex-col gap-2">
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPercent || 0}%` }}
                />
              </div>
              <span className="text-sm text-muted-foreground">{progressMessage || 'Linking…'}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
          <Button onClick={run} disabled={running || Object.keys(paramErrors || {}).length > 0}>
            {running ? 'Linking…' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
