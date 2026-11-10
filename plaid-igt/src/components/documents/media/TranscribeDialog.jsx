import { Mic } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { ChannelChecklist } from './ChannelChecklist.jsx';
import { useChosenChannels } from './useChosenChannels.js';

// Transcription: the button in the Transcript header and the dialog behind it.
// Results are segments with text, which is what the transcript itself shows,
// so the dialog carries the method and its options, and, on a recording with
// a speaker on each channel, the channels to transcribe, one request each.
export function TranscribeDialog({ mediaOps, readOnly = false }) {
  const { writeLock } = useDocumentCtx();
  const {
    transcribeSpot,
    transcribeRun,
    handleTranscribe,
    isUploading,
    stopTranscribe,
    channelSpeakers,
  } = mediaOps;
  const channels = useChosenChannels(channelSpeakers, mediaOps.channelCount);
  return (
    <ServiceSpotDialog
      label="Transcribe"
      icon={Mic}
      description="Segments and their text are written to this document."
      run={transcribeRun}
      spot={transcribeSpot}
      onRun={() => handleTranscribe({ channels: channels.chosen })}
      closeFirst={false}
      onCancel={stopTranscribe}
      writeLock={writeLock}
      noun="transcription"
      disabled={readOnly || isUploading}
      blocked={!transcribeSpot.service || isUploading || channels.none}
    >
      <ChannelChecklist channels={channels} disabled={transcribeRun.running} />
    </ServiceSpotDialog>
  );
}
