import React, { useState } from 'react';
import { AudioLines } from 'lucide-react';
import { ServiceRunDialog } from '../services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '../services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '../services/ServiceRunButton.jsx';

// Speech detection: the button in the Recording header and the dialog behind
// it. Only the controls live here. What detection produces is shown where it
// is used, as outlined blocks on the timeline and as rows in the transcript,
// so the dialog can be closed and the proposals typed into.
//
// With the built-in model every control re-derives the proposals from
// probabilities already produced, so tuning is instant after the one slow pass.
// Only Detect runs the model, and it keeps running with the dialog shut.
export function VadDetection({ mediaOps, readOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const { vad, detectSpot, detectRun, handleDetectSpeech } = mediaOps;
  const { proposals, foundCount, status, error, hasAnalysis } = vad;
  const running = detectRun.running || status === 'running';
  const count = proposals.length;

  const summary =
    count > 0
      ? count === 1
        ? '1 proposed segment'
        : `${count} proposed segments`
      : foundCount === 0
        ? 'No speech found'
        : 'No proposals left';

  return (
    <>
      <ServiceRunButton
        label="Detect speech"
        icon={AudioLines}
        iconOnly
        variant="ghost"
        onClick={() => setOpen(true)}
        progress={detectRun}
        disabled={readOnly || disabled}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Speech detection"
        description="Proposed segments appear on the timeline and in the transcript. Each becomes a segment when you type into it."
        className="sm:max-w-md"
        progress={detectRun}
        error={status === 'error' ? error : null}
        result={status === 'ready' ? summary : null}
        runLabel="Detect"
        onRun={handleDetectSpeech}
        runDisabled={readOnly || disabled}
        onCancel={detectSpot.service ? undefined : vad.cancel}
        secondary={hasAnalysis && !running ? { label: 'Discard', onClick: vad.clear } : undefined}
      >
        <ServiceMethodRow spot={detectSpot} disabled={running} />
      </ServiceRunDialog>
    </>
  );
}
