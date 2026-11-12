import { Mic } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { ChannelChecklist } from './ChannelChecklist.jsx';
import { useChosenChannels } from './useChosenChannels.js';

// Transcription: the button in the Transcript header and the dialog behind it.
// Results are segments with text, which is what the transcript itself shows,
// so the dialog carries the method and its options, and, on a recording with
// a speaker on each channel, the channels to transcribe, one request each.
// Speech detection by a service takes no write lock, so its run is said here
// (`isProcessing`) and keeps Run disabled: refused after Run, the dialog would
// already be gone (REV-RUN-5).
export function TranscribeDialog({ mediaOps, readOnly = false }) {
  const { writeLock } = useDocumentCtx();
  const {
    transcribeSpot,
    handleTranscribe,
    isUploading,
    isProcessing,
    channelSpeakers,
    channelCount,
  } = mediaOps;
  const channels = useChosenChannels(channelSpeakers, channelCount);
  return (
    <ServiceSpotDialog
      label="Transcribe"
      icon={Mic}
      description="Segments and their text are written to this document."
      spot={transcribeSpot}
      onRun={() => handleTranscribe({ channels: channels.chosen })}
      writeLock={writeLock}
      blockedHint={
        isProcessing && !writeLock
          ? 'Speech detection is running. One run at a time on a document.'
          : null
      }
      noun="transcription"
      disabled={readOnly || isUploading}
      blocked={!transcribeSpot.service || isUploading || channels.none || channels.waiting}
    >
      <ChannelChecklist channels={channels} />
    </ServiceSpotDialog>
  );
}
