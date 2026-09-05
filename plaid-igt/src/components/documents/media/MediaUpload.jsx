import React, { useRef } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';

// The upload prompt, and the upload itself once a file is chosen: the bytes
// going up as a bar with the count, then a pulsing bar while the server checks
// the file and the document reloads with it. `progress` is
// `{ name, loaded, total }` while an upload is in flight, else null.
export const MediaUpload = ({ onUpload, isUploading, progress = null, readOnly = false }) => {
  const inputRef = useRef(null);

  const total = progress?.total ?? 0;
  const sent = Math.min(progress?.loaded ?? 0, total);
  const pct = total > 0 ? (sent / total) * 100 : 0;
  const processing = !!progress && total > 0 && sent >= total;

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
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = '';
            }}
          />
          {progress ? (
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
