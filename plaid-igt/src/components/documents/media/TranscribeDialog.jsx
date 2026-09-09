import { useState } from 'react';
import { Mic } from 'lucide-react';
import { ServiceRunDialog } from '../services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '../services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '../services/ServiceRunButton.jsx';

// Transcription: the button in the Transcript header and the dialog behind it.
// Results are segments with text, which is what the transcript itself shows,
// so the dialog carries nothing but the method and its options.
export function TranscribeDialog({ mediaOps, readOnly = false }) {
  const [open, setOpen] = useState(false);
  const { transcribeSpot, transcribeRun, handleTranscribe, isUploading } = mediaOps;
  const running = transcribeRun.running;

  const run = async () => {
    await handleTranscribe();
    setOpen(false);
  };

  return (
    <>
      <ServiceRunButton
        label="Transcribe"
        icon={Mic}
        onClick={() => setOpen(true)}
        progress={transcribeRun}
        disabled={readOnly || isUploading}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Transcribe"
        icon={Mic}
        description="Segments and their text are written to this document."
        progress={transcribeRun}
        runLabel="Transcribe"
        onRun={run}
        runDisabled={
          !transcribeSpot.service ||
          isUploading ||
          Object.keys(transcribeSpot.params.errors).length > 0
        }
      >
        <ServiceMethodRow
          spot={transcribeSpot}
          disabled={running}
          emptyHint="No transcription service is online."
        />
      </ServiceRunDialog>
    </>
  );
}
