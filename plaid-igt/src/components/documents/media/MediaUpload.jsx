import { useEffect, useRef, useState } from 'react';
import { AudioLines, Upload } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Progress } from '@ui/components/ui/progress';
import { cn } from '@ui/lib/utils';
import { formatBytes } from '@/utils/formatBytes';
import { conversionNeed, conversionNote, estimateMp3Bytes } from '@/domain/media/transcodeToMp3';
import { readDuration } from '@/domain/media/mediaDuration';
import { readyRecordings } from '@/utils/readyRecordings';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { SaveStatus } from '@ui/components/shared/SaveStatus.jsx';
import { MixRecordingsDialog } from './MixRecordingsDialog.jsx';
import { ChannelSpeakersDialog } from './ChannelSpeakersDialog.jsx';

// The upload prompt, and the upload itself once a file is chosen: the bytes
// going up as a bar with the count, then a pulsing bar while the server checks
// the file and the document reloads with it. `progress` is
// `{ name, loaded, total }` while an upload is in flight, else null, and
// `convertProgress` is `{ name, fraction }` while a recording is converted.
// `saves` is the document, whose write queue sends the upload: an upload whose
// answer was lost goes again from the first byte until the server answers,
// and the card says so under the bar, as the save pills do (SaveStatus).
// `onCancel` stops the upload, offered until every byte is up: from then on
// the server stores the file whatever the browser does.
//
// The card has two modes, a view setting kept nowhere. Single (the default)
// takes one file, and several are refused with a note naming the switch, so
// none is mixed or left out unasked. Per speaker takes several files, one per
// speaker, which go through the mix dialog and come out as one recording with
// a channel each (MixRecordingsDialog), or one file made elsewhere with a
// speaker per channel (ChannelSpeakersDialog), uploaded once its speakers are
// named: a WAV as it is, any other recording as a WAV of the same channels. A
// video chosen alone there is refused, by its type, with a note naming Single.
// Among several files it is mixed by its sound, as any file is.
export const MediaUpload = ({
  onUpload,
  onCancel = null,
  isUploading,
  progress = null,
  convertProgress = null,
  saves = null,
  maxBytes = null,
  readOnly = false,
  knownSpeakers = [],
  // prepareRecording's options, for a test to say what the browser plays.
  prepareOptions = undefined,
  // The mix dialog's decoder, for a test to say what the browser hears.
  decodeTrack = undefined,
  // What one file under Per speaker holds, for a test (readChannelFile).
  readFile = undefined,
}) => {
  const inputRef = useRef(null);
  // A large file waits here for the choice between sending it and converting
  // it. A small one is uploaded on sight, as it always was.
  const [pending, setPending] = useState(null);
  // Its length, read from the header, so the choice can name the size it would
  // produce rather than a rate to do arithmetic on.
  const [seconds, setSeconds] = useState(null);
  // The name of a recording being converted to PCM WAV before anything else.
  const [decoding, setDecoding] = useState(null);
  // Two or more files, waiting in the mix dialog.
  const [mixing, setMixing] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // 'single' or 'perSpeaker'.
  const [mode, setMode] = useState('single');
  const perSpeaker = mode === 'perSpeaker';
  // One file under Per speaker, waiting in the channel speakers dialog.
  const [channelFile, setChannelFile] = useState(null);
  // Why the files chosen were refused, said under the button, else null.
  const [refusal, setRefusal] = useState(null);

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

  // A recording the browser cannot play is refused here, and an ADPCM WAV is
  // swapped for its PCM decoding, before anything below sees its size. Two or
  // or more files under Per speaker go to the mix dialog, one to the channel
  // speakers dialog.
  const choose = async (pickedList) => {
    const picked = [...(pickedList || [])];
    if (!picked.length || isUploading || readOnly) return;
    setRefusal(null);
    if (picked.length > 1 && !perSpeaker) {
      setRefusal('One file at a time. For a file per speaker, switch to Per speaker.');
      return;
    }
    if (picked.length === 1 && perSpeaker && picked[0].type?.startsWith('video/')) {
      setRefusal('A video cannot be split by speaker. Switch to Single.');
      return;
    }
    let files;
    try {
      files = await readyRecordings(picked, { ...prepareOptions, onConvert: setDecoding });
    } finally {
      setDecoding(null);
    }
    if (!files.length) return;
    if (perSpeaker) {
      if (files.length > 1) setMixing(files);
      else setChannelFile(files[0]);
      return;
    }
    const [file] = files;
    if (conversionNeed(file.size, maxBytes)) setPending(file);
    else onUpload(file);
  };

  const send = (convert) => {
    const file = pending;
    setPending(null);
    onUpload(file, { convert });
  };

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-4',
        dragOver && !isUploading && !readOnly && 'border-primary bg-primary/5',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        choose(e.dataTransfer?.files);
      }}
    >
      {!(decoding || convertProgress || progress || pending) && (
        <div className="flex justify-start">
          <SegmentedControl
            label="Upload"
            value={mode}
            onChange={(next) => {
              setMode(next);
              setRefusal(null);
            }}
            options={[
              { value: 'single', label: 'Single' },
              { value: 'perSpeaker', label: 'Per speaker' },
            ]}
          />
        </div>
      )}
      <div className="flex items-center justify-center">
        <div className="flex w-full flex-col items-center gap-6">
          <Upload className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="mb-1 text-lg font-medium">
              {perSpeaker ? 'Upload media files' : 'Upload media file'}
            </p>
            <p className="mb-4 text-sm text-muted-foreground">
              {perSpeaker
                ? 'One file per speaker, or one file with a channel per speaker.'
                : 'One audio or video file.'}
            </p>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            multiple={perSpeaker}
            className="hidden"
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = '';
            }}
          />
          {decoding ? (
            <div className="flex w-[28rem] max-w-full flex-col gap-2" aria-live="polite">
              <span className="truncate text-sm font-medium">{decoding}</span>
              <Progress label="Conversion progress" />
              <p className="text-xs text-muted-foreground">Converting to PCM WAV.</p>
            </div>
          ) : convertProgress ? (
            <div className="flex w-[28rem] max-w-full flex-col gap-2" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">{convertProgress.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {Math.floor(convertProgress.fraction * 100)}%
                </span>
              </div>
              <Progress value={convertProgress.fraction * 100} label="Conversion progress" />
              <p className="text-xs text-muted-foreground">Converting to MP3.</p>
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
              {(saves || onCancel) && (
                <div className="flex items-center justify-between gap-3">
                  <span>{saves && <SaveStatus doc={saves} />}</span>
                  {onCancel && (
                    <Button variant="outline" size="sm" disabled={processing} onClick={onCancel}>
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : pending ? (
            <div className="flex w-[28rem] max-w-full flex-col gap-3">
              <p className="text-sm">
                <span className="font-medium">{pending.name}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {formatBytes(pending.size, { against: overLimit ? maxBytes : null })}
                </span>
              </p>
              {overLimit && (
                <p className="text-xs font-medium text-destructive">
                  This server accepts {formatBytes(maxBytes, { against: pending.size })}. Sending
                  the file as it is would be refused.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {conversionNote({ bytes: smaller, video: pending.type?.startsWith('video/') })}
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
            <div className="flex flex-col items-center gap-2">
              <Button
                size="lg"
                disabled={isUploading || readOnly}
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                {perSpeaker ? 'Choose media files' : 'Choose media file'}
              </Button>
              {refusal && (
                <p className="text-xs font-medium text-destructive" role="status">
                  {refusal}
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Recommended formats: MP4, WebM, OGG, MOV (video) • MP3, WAV, M4A, AAC (audio)
          </p>
        </div>
      </div>

      <MixRecordingsDialog
        open={!!mixing}
        files={mixing}
        onOpenChange={(next) => !next && setMixing(null)}
        knownSpeakers={knownSpeakers}
        maxBytes={maxBytes}
        {...(decodeTrack ? { decode: decodeTrack } : {})}
        onUpload={(file, options) => {
          setMixing(null);
          onUpload(file, options);
        }}
      />
      <ChannelSpeakersDialog
        open={!!channelFile}
        file={channelFile}
        onOpenChange={(next) => !next && setChannelFile(null)}
        knownSpeakers={knownSpeakers}
        maxBytes={maxBytes}
        {...(readFile ? { readFile } : {})}
        onUpload={(file, options) => {
          setChannelFile(null);
          onUpload(file, options);
        }}
      />
    </div>
  );
};
