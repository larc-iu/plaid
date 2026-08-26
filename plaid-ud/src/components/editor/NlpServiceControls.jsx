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

  if (!enabled) return null;

  // No runnable service: surface "still discovering" vs "nothing online" (+retry).
  if (!hasServices) {
    return isDiscovering ? (
      <Group gap={6}>
        <Loader size={14} color="gray" />
        <Text size="sm" c="dimmed">
          Checking for NLP services…
        </Text>
      </Group>
    ) : (
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          No parsing service online
        </Text>
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
            <ActionIcon
              variant="light"
              color="gray"
              size="lg"
              aria-label="Service options"
              disabled={isParsing}
            >
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
