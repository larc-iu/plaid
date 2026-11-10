import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ui/components/ui/dialog';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Progress } from '@ui/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';
import { notifyError } from '@/utils/feedback';
import { keptChannelsWav, readChannelFile } from '@/domain/media/mixRecordings';
import { keptChannelsBytes, startingQuality } from '@/domain/media/mixdown';
import { QualityChoice } from './QualityChoice.jsx';

// One file chosen under Per speaker: a recording made elsewhere with a
// speaker on each channel. Nothing is mixed. The dialog reads how many
// channels the file has and takes a speaker for each (an entry may stay
// empty). A WAV goes up as it is with `channelSpeakers`. A video never comes
// here: the upload card refuses one under Per speaker. Any
// other recording goes up as a WAV made here with the same channels, channel
// n of the file in channel n of the WAV, at the quality chosen as a mix's is,
// since a recording's channels can be taken apart for transcription only in
// a WAV. A file with one channel has no speakers to tell apart, and is not
// uploaded from here. `readFile` and `makeWav` are readChannelFile and
// keptChannelsWav unless a test says what the file holds. Cancel or the
// Close X while the WAV is made stops it and leaves the dialog as it was.

const SPEAKER_LIST_ID = 'channel-file-speaker-options';

export function ChannelSpeakersDialog({
  file,
  open,
  onOpenChange,
  onUpload,
  knownSpeakers = [],
  maxBytes = null,
  readFile = readChannelFile,
  makeWav = keptChannelsWav,
}) {
  // `{ status: 'reading' | 'ready' | 'failed', channels, convert, ... }`, the
  // rest of readChannelFile's answer when the file is made a WAV.
  const [read, setRead] = useState({ status: 'reading', channels: 0 });
  const [speakers, setSpeakers] = useState([]);
  // The quality chosen, null until one is (startingQuality holds till then).
  const [chosen, setChosen] = useState(null);
  // True while the WAV is written.
  const [converting, setConverting] = useState(false);
  // Stops a read or a conversion when the dialog goes away.
  const convertAbort = useRef(null);
  useEffect(() => () => convertAbort.current?.abort(), []);

  useEffect(() => {
    if (!open || !file) return undefined;
    const abort = new AbortController();
    setRead({ status: 'reading', channels: 0 });
    setSpeakers([]);
    setChosen(null);
    setConverting(false);
    readFile(file, { signal: abort.signal }).then(
      (answer) => {
        if (abort.signal.aborted) return;
        setRead({ ...answer, status: 'ready' });
        setSpeakers(Array.from({ length: answer.channels }, () => ''));
      },
      (error) => {
        if (abort.signal.aborted) return;
        console.error('Reading the recording failed:', error);
        setRead({ status: 'failed', channels: 0 });
      },
    );
    return () => abort.abort();
  }, [open, file, readFile]);

  const ready = read.status === 'ready';
  const oneChannel = ready && read.channels < 2;
  const convert = ready && read.convert;
  const bytesOf = (q) => (convert ? keptChannelsBytes(read, q) : null);
  const quality = chosen ?? startingQuality(bytesOf, maxBytes);
  const bytes = convert ? bytesOf(quality) : (file?.size ?? null);
  const overLimit = maxBytes != null && bytes != null && bytes > maxBytes;
  const canUpload = ready && !oneChannel && !overLimit && !converting;

  const upload = async () => {
    if (!canUpload) return;
    const channelSpeakers = speakers.map((s) => s.trim());
    if (!convert) {
      onOpenChange(false);
      onUpload(file, { channelSpeakers });
      return;
    }
    setConverting(true);
    const abort = new AbortController();
    convertAbort.current = abort;
    try {
      const wav = await makeWav({ ...read, file }, { quality, signal: abort.signal });
      // The WAV is written in one go on the main thread, so a click on Cancel
      // made meanwhile is still waiting: it is let in before the check.
      await new Promise((done) => setTimeout(done));
      if (abort.signal.aborted) return;
      onOpenChange(false);
      onUpload(wav, { channelSpeakers });
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error('Converting the recording failed:', error);
      notifyError(error?.message || 'The recording could not be converted.', 'Failed to convert');
      setConverting(false);
    }
  };

  const stopConverting = () => {
    convertAbort.current?.abort();
    setConverting(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (converting ? stopConverting() : onOpenChange(next))}
    >
      <DialogContent
        className="max-w-lg"
        closeLabel="Close Speakers per channel"
        onInteractOutside={(e) => converting && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Speakers per channel</DialogTitle>
          <DialogDescription>One file with a speaker on each channel.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-sm">
            <span className="font-mono text-xs">{file?.name}</span>
            <span
              className={`text-xs ${read.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {' · '}
              {read.status === 'reading'
                ? 'Reading…'
                : read.status === 'failed'
                  ? 'Cannot be decoded.'
                  : `${read.channels} ${read.channels === 1 ? 'channel' : 'channels'}`}
            </span>
          </p>

          {oneChannel && (
            <p className="text-xs font-medium text-destructive">
              One channel. Choose two or more files, or a file with a channel per speaker.
            </p>
          )}

          {ready && !oneChannel && (
            <ul className="flex flex-col gap-2">
              {speakers.map((speaker, i) => (
                <li key={i} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
                  <span className="text-xs text-muted-foreground">Channel {i + 1}</span>
                  <Input
                    value={speaker}
                    list={SPEAKER_LIST_ID}
                    placeholder="Speaker"
                    compose
                    autoComplete="off"
                    aria-label={`Channel ${i + 1} speaker`}
                    disabled={converting}
                    className="h-8 text-xs"
                    onChange={(e) =>
                      setSpeakers((prev) => prev.map((s, k) => (k === i ? e.target.value : s)))
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          <datalist id={SPEAKER_LIST_ID}>
            {knownSpeakers.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>

          {convert && !oneChannel && (
            <>
              <p className="text-xs text-muted-foreground">Uploaded as a WAV.</p>
              <QualityChoice
                value={quality}
                onChange={setChosen}
                fullRate={read.sampleRate}
                bytesOf={bytesOf}
                maxBytes={maxBytes}
                disabled={converting}
              />
            </>
          )}

          {overLimit && (
            <p className="text-xs font-medium text-destructive">
              This server accepts {formatBytes(maxBytes, { against: bytes })}.{' '}
              {convert ? 'The WAV is' : 'The file is'} {formatBytes(bytes, { against: maxBytes })}.
            </p>
          )}

          {converting && (
            <div className="flex flex-col gap-1" aria-live="polite">
              <Progress label="Conversion progress" />
              <p className="text-xs text-muted-foreground">Converting to WAV.</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => (converting ? stopConverting() : onOpenChange(false))}
          >
            Cancel
          </Button>
          <Button onClick={upload} disabled={!canUpload}>
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
