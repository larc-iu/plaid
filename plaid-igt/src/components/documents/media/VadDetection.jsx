import { useState } from 'react';
import { AudioLines } from 'lucide-react';
import { ServiceRunDialog } from '@ui/components/services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '@ui/components/services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '@ui/components/services/ServiceRunButton.jsx';
import { ChannelChecklist } from './ChannelChecklist.jsx';
import { useChosenChannels } from './useChosenChannels.js';
import { t } from '@ui/lib/i18n.js';

// Speech detection: the button in the Recording header and the dialog behind
// it. Only the controls live here. What detection produces is shown where it
// is used, as outlined blocks on the timeline and as rows in the transcript,
// so the dialog can be closed and the proposals typed into.
//
// With the built-in model every control re-derives the proposals from
// probabilities already produced, so tuning is instant after the one slow pass.
// Only Detect runs the model, and it keeps running with the dialog shut.
//
// A recording with a speaker on each channel lists the channels, each with a
// box, and the detector listens to each chosen channel on its own.
export function VadDetection({ mediaOps, readOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const {
    vad,
    detectSpot,
    detectRun,
    handleDetectSpeech,
    cancelRequest,
    channelSpeakers,
    channelCount,
  } = mediaOps;
  const { proposals, foundCount, discardedCount, status, error, hasAnalysis } = vad;
  const running = detectRun.running || status === 'running';
  const count = proposals.length;
  // Both methods stop from the one button: the built-in model aborts its
  // worker, a service is asked to stop. A service run used to offer neither.
  const stopDetection = detectSpot.service ? cancelRequest : vad.cancel;
  const channels = useChosenChannels(channelSpeakers, channelCount);

  // Kept proposals show whatever method is chosen, so the one that made them
  // is named.
  // The built-in is named as the method list names it, in the interface's
  // language, whatever language its name was kept in.
  const by =
    detectSpot.options?.find((o) => o.builtin && o.value === vad.madeBy?.key)?.label ??
    vad.madeBy?.name;
  const summary =
    count > 0
      ? by
        ? t(
            '{n, plural, one {# proposed segment from “{name}”} other {# proposed segments from “{name}”}}',
            { n: count, name: by },
          )
        : t('{n, plural, one {# proposed segment} other {# proposed segments}}', { n: count })
      : foundCount === 0
        ? t('No speech found')
        : t('No proposals left');

  return (
    <>
      <ServiceRunButton
        label={t('Detect speech')}
        icon={AudioLines}
        iconOnly
        variant="ghost"
        onClick={() => setOpen(true)}
        running={running}
        disabled={readOnly || disabled}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title={t('Speech detection')}
        description={t(
          'Proposals show on the timeline and in the transcript, dashed. Type into one to make it a segment.',
        )}
        className="sm:max-w-md"
        progress={detectRun}
        error={status === 'error' ? error : null}
        result={status === 'ready' ? summary : null}
        runLabel={t('Detect')}
        onRun={() => handleDetectSpeech({ channels: channels.chosen })}
        runDisabled={readOnly || disabled || channels.none || channels.waiting}
        onCancel={stopDetection}
        // A run that found no speech left nothing to discard.
        secondary={
          hasAnalysis && !running && foundCount !== 0
            ? { label: t('Discard'), onClick: vad.clear }
            : undefined
        }
      >
        <ServiceMethodRow spot={detectSpot} disabled={running} />
        <ChannelChecklist channels={channels} disabled={running} />
        {/* Detect starts fresh: what was discarded is proposed again. */}
        {discardedCount > 0 && !running && (
          <p className="text-xs text-muted-foreground">
            {t(
              '{n, plural, one {# discarded proposal comes back on Detect.} other {# discarded proposals come back on Detect.}}',
              { n: discardedCount },
            )}
          </p>
        )}
      </ServiceRunDialog>
    </>
  );
}
