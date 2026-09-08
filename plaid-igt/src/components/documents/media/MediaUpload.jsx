import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';
import { conversionNeed, estimateMp3Bytes, MP3_BITRATE_KBPS } from '@/domain/media/transcodeToMp3';
import { readDuration } from '@/domain/media/mediaDuration';

const HOUR_MB = Math.round((3600 * MP3_BITRATE_KBPS * 1000) / 8 / 1e6);

// The upload prompt, and the upload itself once a file is chosen: the bytes
// going up as a bar with the count, then a pulsing bar while the server checks
// the file and the document reloads with it. `progress` is
// `{ name, loaded, total }` while an upload is in flight, else null, and
// `convertProgress` is `{ name, fraction }` while a recording is converted.
export const MediaUpload = ({
  onUpload,
  isUploading,
  progress = null,
  convertProgress = null,
  maxBytes = null,
  readOnly = false,
}) => {
  const inputRef = useRef(null);
  // A large file waits here for the choice between sending it and converting
  // it. A small one is uploaded on sight, as it always was.
  const [pending, setPending] = useState(null);
  // Its length, read from the header, so the choice can name the size it would
  // produce rather than a rate to do arithmetic on.
  const [seconds, setSeconds] = useState(null);

  useEffect(() => {
    if (!pending) return undefined;
    let alive = true;
    setSeconds(null);
    readDuration(pending).then((value) => {
      if (alive) setSeconds(value);
    });
    return () => {
      alive = false;
    };
  }, [pending]);

  const total = progress?.total ?? 0;
  const sent = Math.min(progress?.loaded ?? 0, total);
  const pct = total > 0 ? (sent / total) * 100 : 0;
  const processing = !!progress && total > 0 && sent >= total;

  // Over the server's limit there is no question to ask: sending it as it is
  // would fail after the whole upload.
  const overLimit = !!pending && conversionNeed(pending.size, maxBytes) === 'required';
  const smaller = Number.isFinite(seconds) && seconds > 0 ? estimateMp3Bytes(seconds) : null;

  const choose = (file) => {
    if (!file) return;
    if (conversionNeed(file.size, maxBytes)) setPending(file);
    else onUpload(file);
  };

  const send = (convert) => {
    const file = pending;
    setPending(null);
    onUpload(file, { convert });
  };

  return (
    <div className="tw rounded-lg border bg-card p-4">
      <div className="flex items-center justify-center">
        <div className="flex w-full flex-col items-center gap-6">
          <Upload className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="mb-1 text-lg font-medium">Upload Media File</p>
            <p className="mb-4 text-sm text-muted-foreground">
              Upload an audio or video file to begin time-aligned transcription
            </p>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {convertProgress ? (
            <div className="flex w-[28rem] max-w-full flex-col gap-2" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">{convertProgress.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {Math.floor(convertProgress.fraction * 100)}%
                </span>
              </div>
              <Progress value={convertProgress.fraction * 100} label="Conversion progress" />
              <p className="text-xs text-muted-foreground">Converting to audio.</p>
            </div>
          ) : progress ? (
            <div className="flex w-[28rem] max-w-full flex-col gap-2" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">{progress.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {processing ? 'Processing…' : `${Math.floor(pct)}%`}
                </span>
              </div>
              <Progress value={processing ? undefined : pct} label="Upload progress" />
              <p className="text-xs text-muted-foreground">
                {processing
                  ? 'Checking the file and saving it.'
                  : `${formatBytes(sent)} of ${formatBytes(total)}`}
              </p>
            </div>
          ) : pending ? (
            <div className="flex w-[28rem] max-w-full flex-col gap-3">
              <p className="text-sm">
                <span className="font-medium">{pending.name}</span>
                <span className="text-muted-foreground"> · {formatBytes(pending.size)}</span>
              </p>
              {overLimit && (
                <p className="text-xs font-medium text-destructive">
                  This server accepts {formatBytes(maxBytes)}. Sending the file as it is would be
                  refused.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Mono at 16 kHz, timed exactly as the original: clear enough to transcribe from, too
                coarse for phonetic measurement
                {pending.type?.startsWith('video/') ? ', and without the picture' : ''}.
                {smaller ? '' : ` An MP3 is about ${HOUR_MB} MB an hour.`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => send(true)}>
                  <AudioLines className="h-4 w-4" /> Convert to{' '}
                  {smaller ? `a ${formatBytes(smaller)} MP3` : 'MP3'}
                </Button>
                <Button variant="outline" disabled={overLimit} onClick={() => send(false)}>
                  Upload as it is
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="lg"
              disabled={isUploading || readOnly}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              Choose Media File
            </Button>
          )}

          <p className="text-xs text-muted-foreground">
            Recommended formats: MP4, WebM, OGG, MOV (video) • MP3, WAV, M4A, AAC (audio)
          </p>
        </div>
      </div>
    </div>
  );
};
