import { useEffect, useRef } from 'react';
import { Zap, SlidersHorizontal } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { ServiceSummary } from './ServiceSummary.jsx';
import { ServiceParamForm } from './ServiceParamForm.jsx';
import { useNlpService } from './hooks/useNlpService.js';
import { notifySuccess, notifyWarning } from '../../utils/feedback.jsx';

// The shared NLP "Parse" cluster used by both the Text Editor and the
// Annotate tab: discover parse-capable services, pick one, fill its declared
// arguments, and run it. Renders nothing unless `enabled` (text present,
// editable, not time-traveling). On a successful parse it toasts and calls
// `onParsed` so the host can refresh its view. `onParsed` may be an inline
// arrow — it's read through a ref so its identity never re-fires the effect.
export const NlpServiceControls = ({ projectId, documentId, project, enabled, onParsed }) => {
  const {
    isParsing,
    isDiscovering,
    hasServices,
    parseStatus,
    parseSummary,
    parseProgress,
    discoverServices,
    requestParse,
    cancelParse,
    clearParseStatus,
    canParse,
    parseServices,
    selectedServiceId,
    setSelectedService,
    selectedService,
    paramSchema,
    paramValues,
    paramErrors,
    setParam,
  } = useNlpService(projectId, documentId, project);

  const onParsedRef = useRef(onParsed);
  onParsedRef.current = onParsed;
  // Read the summary through a ref so the effect stays keyed only on the status
  // transition (it's set atomically with parseStatus, so it's current here).
  const parseSummaryRef = useRef(parseSummary);
  parseSummaryRef.current = parseSummary;

  // On parse success: refresh the host's data, toast the service's own notice,
  // then clear status after a beat. Keyed only on the status transition so it
  // fires exactly once.
  useEffect(() => {
    if (parseStatus !== 'success') return;
    onParsedRef.current?.();

    // The service authors the toast text (headline + body) and picks its
    // severity via `notice.level`; we only map that to a colour. This keeps a
    // no-op parse (every sentence skipped as human-annotated) from claiming
    // success. Fall back to the counts for a service predating the notice
    // contract, so we still never claim more than we know.
    const summary = parseSummaryRef.current;
    const notice = summary?.notice;
    if (notice) {
      const show = notice.level === 'success' ? notifySuccess : notifyWarning;
      show(notice.message || undefined, notice.title);
    } else if (summary?.parsedSentences > 0) {
      const n = summary.parsedSentences;
      notifySuccess(`Parsed ${n} sentence${n === 1 ? '' : 's'}.`);
    } else {
      notifyWarning('The parser reported no changes to this document.', 'Nothing to parse');
    }

    const timer = setTimeout(() => clearParseStatus(), 3000);
    return () => clearTimeout(timer);
  }, [parseStatus, clearParseStatus]);

  // A stop is neither a success nor a failure, so it gets neither toast. The
  // parser's write phase takes no checkpoints, so a run it reports as stopped
  // stopped before it wrote anything: say so, and don't refresh a document
  // that did not change.
  useEffect(() => {
    if (parseStatus !== 'stopped') return;
    notifyWarning('Nothing was written.', 'Parse stopped');
    const timer = setTimeout(() => clearParseStatus(), 3000);
    return () => clearTimeout(timer);
  }, [parseStatus, clearParseStatus]);

  if (!enabled) return null;

  // No runnable service: surface "still discovering" vs "nothing online" (+retry).
  if (!hasServices) {
    return isDiscovering ? (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary" />
        Checking for parsing services…
      </div>
    ) : (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">No parsing service online</span>
        <Button variant="secondary" size="sm" onClick={discoverServices}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={selectedServiceId ?? undefined} onValueChange={setSelectedService}>
        <SelectTrigger className="w-[220px]" disabled={isParsing} aria-label="Parsing service">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {parseServices.map((s) => (
            <SelectItem key={s.serviceId} value={s.serviceId}>
              {s.serviceName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ServiceSummary service={selectedService} />

      {paramSchema.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Service options"
              disabled={isParsing}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <ServiceParamForm
              schema={paramSchema}
              values={paramValues}
              errors={paramErrors}
              onChange={setParam}
              disabled={isParsing}
            />
          </PopoverContent>
        </Popover>
      )}

      <Button
        className="bg-emerald-600 text-white hover:bg-emerald-700"
        onClick={requestParse}
        disabled={!canParse || isParsing}
      >
        {isParsing ? (
          <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : (
          <Zap className="mr-2 h-4 w-4" />
        )}
        Parse
      </Button>

      {isParsing && (
        <>
          <Button variant="outline" onClick={cancelParse}>
            Stop
          </Button>
          {/* The parser names each stretch of its work, and this is the only
              moving part while it is quiet. */}
          {parseProgress?.message && (
            <span className="text-sm text-muted-foreground">
              {parseProgress.percent != null && `${parseProgress.percent}% · `}
              {parseProgress.message}
            </span>
          )}
        </>
      )}
    </div>
  );
};
