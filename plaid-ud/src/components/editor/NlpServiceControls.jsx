import { useEffect, useRef } from 'react';
import { Group, Text, Loader, Select, Popover, ActionIcon, Button } from '@mantine/core';
import { IconBolt, IconAdjustments } from '@tabler/icons-react';
import { ServiceSummary } from './ServiceSummary.jsx';
import { ServiceParamForm } from './ServiceParamForm.jsx';
import { useNlpService } from './hooks/useNlpService.js';
import { notifySuccess, notifyWarning } from '../../utils/feedback.jsx';

// The shared NLP "Auto Parse" cluster used by both the Text Editor and the
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
    discoverServices,
    requestParse,
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

  // On parse success: refresh the host's data, then toast what the parse
  // ACTUALLY did, then clear status after a beat. Keyed only on the status
  // transition so it fires exactly once.
  useEffect(() => {
    if (parseStatus !== 'success') return;
    onParsedRef.current?.();

    // The service reports {parsedSentences, skippedSentences}. A parse that
    // skipped every sentence (their annotations are treated as human-made or
    // verified) did nothing — say so, and point at the Overwrite option —
    // rather than claiming success and leaving the user staring at an
    // unchanged document.
    const summary = parseSummaryRef.current;
    const parsed = summary?.parsedSentences;
    const skipped = summary?.skippedSentences ?? 0;
    if (typeof parsed !== 'number') {
      notifySuccess('Document parsed successfully!'); // older service: no summary
    } else if (parsed > 0) {
      const kept = skipped > 0 ? `, kept ${skipped} with existing annotations` : '';
      notifySuccess(`Parsed ${parsed} sentence${parsed === 1 ? '' : 's'}${kept}.`);
    } else if (skipped > 0) {
      notifyWarning(
        `${skipped} sentence${skipped === 1 ? '' : 's'} already carry annotations Plaid treats `
        + `as human-made or verified, so ${skipped === 1 ? 'it was' : 'they were'} left `
        + `untouched. Turn on the service's "Overwrite human-edited annotations" option to `
        + `re-parse them.`,
        'Nothing to parse',
      );
    } else {
      notifyWarning('The parser found nothing to parse in this document.', 'Nothing to parse');
    }

    const timer = setTimeout(() => clearParseStatus(), 3000);
    return () => clearTimeout(timer);
  }, [parseStatus, clearParseStatus]);

  if (!enabled) return null;

  // No runnable service: surface "still discovering" vs "nothing online" (+retry).
  if (!hasServices) {
    return isDiscovering ? (
      <Group gap={6}>
        <Loader size={14} color="gray" />
        <Text size="sm" c="dimmed">Checking for NLP services…</Text>
      </Group>
    ) : (
      <Group gap="xs">
        <Text size="sm" c="dimmed">No parsing service online</Text>
        <Button size="xs" variant="light" color="gray" onClick={discoverServices}>
          Retry
        </Button>
      </Group>
    );
  }

  return (
    <Group gap="xs">
      <Select
        size="sm"
        w={220}
        data={parseServices.map((s) => ({ value: s.serviceId, label: s.serviceName }))}
        value={selectedServiceId}
        onChange={(v) => v && setSelectedService(v)}
        allowDeselect={false}
        disabled={isParsing}
        aria-label="Parsing service"
      />

      <ServiceSummary service={selectedService} />

      {paramSchema.length > 0 && (
        <Popover width={320} position="bottom-end" withArrow shadow="md">
          <Popover.Target>
            <ActionIcon variant="light" color="gray" size="lg" aria-label="Service options" disabled={isParsing}>
              <IconAdjustments size={18} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <ServiceParamForm
              schema={paramSchema}
              values={paramValues}
              errors={paramErrors}
              onChange={setParam}
              disabled={isParsing}
            />
          </Popover.Dropdown>
        </Popover>
      )}

      <Button
        color="green"
        leftSection={<IconBolt size={16} />}
        onClick={requestParse}
        disabled={!canParse || isParsing}
        loading={isParsing}
      >
        Auto Parse
      </Button>
    </Group>
  );
};
