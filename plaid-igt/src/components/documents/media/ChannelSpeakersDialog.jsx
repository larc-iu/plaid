import { useEffect, useState } from 'react';
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
import { formatBytes } from '@/utils/formatBytes';
import { readChannelCount } from '@/domain/media/mixRecordings';

// One file chosen under Per speaker: a recording made elsewhere with a
// speaker on each channel. Nothing is mixed. The dialog reads how many
// channels the file has, takes a speaker for each (an entry may stay empty),
// and hands the upload the file as it is with `channelSpeakers`. A file with
// one channel has no speakers to tell apart, and is not uploaded from here.
// `readChannels` is readChannelCount unless a test says what the file holds.

const SPEAKER_LIST_ID = 'channel-file-speaker-options';

export function ChannelSpeakersDialog({
  file,
  open,
  onOpenChange,
  onUpload,
  knownSpeakers = [],
  maxBytes = null,
  readChannels = readChannelCount,
}) {
  // `{ status: 'reading' | 'ready' | 'failed', channels }`
  const [read, setRead] = useState({ status: 'reading', channels: 0 });
  const [speakers, setSpeakers] = useState([]);

  useEffect(() => {
    if (!open || !file) return undefined;
    let alive = true;
    setRead({ status: 'reading', channels: 0 });
    setSpeakers([]);
    readChannels(file).then(
      (channels) => {
        if (!alive) return;
        setRead({ status: 'ready', channels });
        setSpeakers(Array.from({ length: channels }, () => ''));
      },
      (error) => {
        console.error('Reading the recording failed:', error);
        if (alive) setRead({ status: 'failed', channels: 0 });
      },
    );
    return () => {
      alive = false;
    };
  }, [open, file, readChannels]);

  const oneChannel = read.status === 'ready' && read.channels < 2;
  const overLimit = maxBytes != null && file != null && file.size > maxBytes;
  const canUpload = read.status === 'ready' && !oneChannel && !overLimit;

  const upload = () => {
    if (!canUpload) return;
    onOpenChange(false);
    onUpload(file, { channelSpeakers: speakers.map((s) => s.trim()) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" closeLabel="Close Speakers per channel">
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

          {read.status === 'ready' && !oneChannel && (
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

          {overLimit && (
            <p className="text-xs font-medium text-destructive">
              This server accepts {formatBytes(maxBytes, { against: file.size })}. The file is{' '}
              {formatBytes(file.size, { against: maxBytes })}.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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
