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
import { readTrack, mixTracks } from '@/domain/media/mixRecordings';
import { mixBytes, mixRate, trackNote } from '@/domain/media/mixdown';
import { formatTime } from './formatTime.js';
import { QualityChoice, startingQuality } from './QualityChoice.jsx';

// Several files chosen at once, one per speaker, become one recording with a
// channel each. The dialog lists the files as they are read, takes a speaker
// and an offset for each, offers the two qualities with the size each comes
// to, and refuses a mix the server would not take before a byte goes up.
// The files are read one at a time and only their length, channels and rate
// are kept. Closing the dialog stops the reads and the mix. Cancel or the
// Close X while it mixes stops the mix and leaves the dialog as it was.
// `decode` is readTrack unless a test says what the browser hears.

const SPEAKER_LIST_ID = 'mix-speaker-options';

export function MixRecordingsDialog({
  files,
  open,
  onOpenChange,
  onUpload,
  knownSpeakers = [],
  maxBytes = null,
  decode = readTrack,
}) {
  const [tracks, setTracks] = useState([]);
  // The quality chosen, null until one is (startingQuality holds till then).
  const [chosen, setChosen] = useState(null);
  // `{ index, total }` while the mix is written, else null.
  const [mixing, setMixing] = useState(null);
  // Aborts the mix when the dialog goes away.
  const mixAbort = useRef(null);
  useEffect(() => () => mixAbort.current?.abort(), []);

  // Read every file once, in order, as soon as the dialog has them.
  useEffect(() => {
    if (!open || !files?.length) return undefined;
    const abort = new AbortController();
    setTracks(
      files.map((f) => ({
        file: f,
        name: f.name,
        size: f.size,
        status: 'reading',
        speaker: '',
        offset: '',
      })),
    );
    setChosen(null);
    setMixing(null);
    (async () => {
      for (const file of files) {
        let read;
        try {
          read = { ...(await decode(file, { signal: abort.signal })), status: 'ready' };
        } catch (error) {
          if (abort.signal.aborted) return;
          console.error('Decoding a recording failed:', error);
          read = { status: 'failed' };
        }
        if (abort.signal.aborted) return;
        // By the file, since a row above may have been removed meanwhile.
        setTracks((prev) => prev.map((t) => (t.file === file ? { ...t, ...read } : t)));
      }
    })();
    return () => abort.abort();
  }, [open, files, decode]);

  // A mix of one file has no speakers to tell apart.
  const tooFew = tracks.length < 2;
  const ready = !tooFew && tracks.every((t) => t.status === 'ready');
  const failed = tracks.some((t) => t.status === 'failed');
  const plan = ready
    ? tracks.map((t) => ({
        seconds: t.seconds,
        sampleRate: t.sampleRate,
        offset: Number(t.offset) || 0,
      }))
    : null;
  const bytesOf = (q) => (plan ? mixBytes(plan, q) : null);
  const quality = chosen ?? startingQuality(bytesOf, maxBytes);
  const bytes = bytesOf(quality);
  const overLimit = maxBytes != null && bytes != null && bytes > maxBytes;

  const setTrack = (i, patch) =>
    setTracks((prev) => prev.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const removeTrack = (i) => setTracks((prev) => prev.filter((_, k) => k !== i));

  const upload = async () => {
    if (!ready || overLimit || mixing) return;
    setMixing({ index: 0, total: tracks.length });
    const abort = new AbortController();
    mixAbort.current = abort;
    try {
      const file = await mixTracks(
        tracks.map((t) => ({ ...t, offset: Number(t.offset) || 0 })),
        {
          quality,
          signal: abort.signal,
          onProgress: (index, total) => setMixing({ index, total }),
        },
      );
      if (abort.signal.aborted) return;
      const channelSpeakers = tracks.map((t) => t.speaker.trim());
      onOpenChange(false);
      onUpload(file, { channelSpeakers });
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error('Mixing the recordings failed:', error);
      notifyError(error?.message || 'The recordings could not be mixed.', 'Failed to mix');
      setMixing(null);
    }
  };

  const stopMix = () => {
    mixAbort.current?.abort();
    setMixing(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (mixing ? stopMix() : onOpenChange(next))}>
      <DialogContent
        className="max-w-2xl"
        closeLabel="Close Mix recordings"
        onInteractOutside={(e) => mixing && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Mix recordings</DialogTitle>
          <DialogDescription>
            One recording with a channel per file. The speaker goes on the channel.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y rounded-md border px-3">
            {tracks.map((t, i) => (
              <li
                key={`${t.name}:${i}`}
                className="grid grid-cols-[minmax(0,1fr)_10rem_6rem] items-center gap-x-3 gap-y-1 py-2"
              >
                <div className="flex min-w-0 flex-col items-start">
                  <span className="max-w-full truncate font-mono text-xs">{t.name}</span>
                  <span
                    className={`text-xs ${t.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {t.status === 'reading'
                      ? 'Reading…'
                      : t.status === 'failed'
                        ? 'Cannot be decoded.'
                        : `${formatTime(t.seconds)} · ${trackNote(t)}${
                            t.file?.type?.startsWith('video/') ? ' · video, sound only' : ''
                          }`}
                  </span>
                  {t.status === 'failed' && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      aria-label={`Remove ${t.name}`}
                      onClick={() => removeTrack(i)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <Input
                  value={t.speaker}
                  list={SPEAKER_LIST_ID}
                  placeholder="Speaker"
                  compose
                  autoComplete="off"
                  aria-label={`${t.name} speaker`}
                  disabled={!!mixing}
                  className="h-8 text-xs"
                  onChange={(e) => setTrack(i, { speaker: e.target.value })}
                />
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    step="0.1"
                    value={t.offset}
                    placeholder="0"
                    aria-label={`${t.name} offset in seconds`}
                    disabled={!!mixing}
                    className="h-8 text-xs tabular-nums"
                    onChange={(e) => setTrack(i, { offset: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground">s</span>
                </div>
              </li>
            ))}
          </ul>
          <datalist id={SPEAKER_LIST_ID}>
            {knownSpeakers.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {tooFew && tracks.length > 0 && (
            <p className="text-xs font-medium text-destructive">A mix takes two files or more.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Offset: silence before the file, in seconds. Negative trims its start.
          </p>

          <QualityChoice
            value={quality}
            onChange={setChosen}
            fullRate={plan ? mixRate(plan, 'full') : null}
            bytesOf={bytesOf}
            maxBytes={maxBytes}
            disabled={!!mixing}
          />

          {overLimit && (
            <p className="text-xs font-medium text-destructive">
              This server accepts {formatBytes(maxBytes, { against: bytes })}. The mix is{' '}
              {formatBytes(bytes, { against: maxBytes })}.
            </p>
          )}

          {mixing && (
            <div className="flex flex-col gap-1" aria-live="polite">
              <Progress value={(mixing.index / mixing.total) * 100} label="Mix progress" />
              <p className="text-xs text-muted-foreground">
                {mixing.index < mixing.total
                  ? `Mixing ${tracks[mixing.index]?.name ?? ''} (${mixing.index + 1} of ${mixing.total}).`
                  : 'Writing the file.'}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => (mixing ? stopMix() : onOpenChange(false))}>
            Cancel
          </Button>
          <Button onClick={upload} disabled={!ready || failed || overLimit || !!mixing}>
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
