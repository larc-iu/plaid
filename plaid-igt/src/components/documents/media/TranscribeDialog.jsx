import { Mic } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

// Transcription: the button in the Transcript header and the dialog behind it.
// Results are segments with text, which is what the transcript itself shows,
// so the dialog carries nothing but the method and its options.
export function TranscribeDialog({ mediaOps, readOnly = false }) {
  const { writeLock } = useDocumentCtx();
  const { transcribeSpot, transcribeRun, handleTranscribe, isUploading, stopTranscribe } = mediaOps;
  return (
    <ServiceSpotDialog
      label="Transcribe"
      icon={Mic}
      description="Segments and their text are written to this document."
      run={transcribeRun}
      spot={transcribeSpot}
      onRun={handleTranscribe}
      closeFirst={false}
      onCancel={stopTranscribe}
      writeLock={writeLock}
      noun="transcription"
      disabled={readOnly || isUploading}
      blocked={!transcribeSpot.service || isUploading}
    />
  );
}
