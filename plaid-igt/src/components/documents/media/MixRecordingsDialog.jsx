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
import { SMALL_RATE, mixBytes, mixRate, trackNote } from '@/domain/media/mixdown';
import { formatTime } from './formatTime.js';

// Several files chosen at once, one per speaker, become one recording with a
// channel each. The dialog lists the files as they are read, takes a speaker
// and an offset for each, offers the two qualities with the size each comes
// to, and refuses a mix the server would not take before a byte goes up.
// The files are read one at a time and only their length, channels and rate
// are kept. Closing the dialog stops the reads and the mix.
// `decode` is readTrack unless a test says what the browser hears.

const SPEAKER_LIST_ID = 'mix-speaker-options';

const QUALITIES = [
  ['full', (rate) => `Full quality (${Math.round(rate / 100) / 10} kHz)`],
  ['small', () => `Smaller (${SMALL_RATE / 1000} kHz)`],
];

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
  const [quality, setQuality] = useState('full');
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
    setMixing(null);
    (async () => {
      for (const [i, file] of files.entries()) {
        let read;
        try {
          read = { ...(await decode(file, { signal: abort.signal })), status: 'ready' };
        } catch (error) {
          if (abort.signal.aborted) return;
          console.error('Decoding a recording failed:', error);
          read = { status: 'failed' };
        }
        if (abort.signal.aborted) return;
        setTracks((prev) => prev.map((t, k) => (k === i ? { ...t, ...read } : t)));
      }
    })();
    return () => abort.abort();
  }, [open, files, decode]);

  const ready = tracks.length > 0 && tracks.every((t) => t.status === 'ready');
  const failed = tracks.some((t) => t.status === 'failed');
  const plan = ready
    ? tracks.map((t) => ({
        seconds: t.seconds,
        sampleRate: t.sampleRate,
        offset: Number(t.offset) || 0,
      }))
    : null;
  const bytesOf = (q) => (plan ? mixBytes(plan, q) : null);
  const bytes = bytesOf(quality);
  const overLimit = maxBytes != null && bytes != null && bytes > maxBytes;
  // Files already at the smaller rate or below have nothing to gain from it,
  // so only the full quality is offered.
  const qualities = plan && mixRate(plan, 'full') <= SMALL_RATE ? QUALITIES.slice(0, 1) : QUALITIES;

  const setTrack = (i, patch) =>
    setTracks((prev) => prev.map((t, k) => (k === i ? { ...t, ...patch } : t)));

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

  return (
    <Dialog open={open} onOpenChange={(next) => !mixing && onOpenChange(next)}>
      <DialogContent className="max-w-2xl" closeLabel="Close Mix recordings">
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
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-xs">{t.name}</span>
                  <span
                    className={`text-xs ${t.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {t.status === 'reading'
                      ? 'Reading…'
                      : t.status === 'failed'
                        ? 'Cannot be decoded.'
                        : `${formatTime(t.seconds)} · ${trackNote(t)}`}
                  </span>
                </div>
                <Input
                  value={t.speaker}
                  list={SPEAKER_LIST_ID}
                  placeholder="Speaker"
                  compose
                  autoComplete="off"
                  aria-label={`${t.name} speaker`}
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
          <p className="text-xs text-muted-foreground">
            Offset: silence before the file, in seconds. Negative trims its start.
          </p>

          <div role="radiogroup" aria-label="Quality" className="flex flex-col gap-1 text-sm">
            {qualities.map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="mix-quality"
                  value={value}
                  checked={quality === value}
                  disabled={!!mixing}
                  onChange={() => setQuality(value)}
                />
                <span>{label(plan ? mixRate(plan, 'full') : 0)}</span>
                {bytesOf(value) != null && (
                  <span className="text-xs text-muted-foreground">
                    · {formatBytes(bytesOf(value), { against: maxBytes })}
                  </span>
                )}
              </label>
            ))}
          </div>

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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!mixing}>
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
