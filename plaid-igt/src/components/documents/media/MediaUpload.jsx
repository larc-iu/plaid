import React, { useRef } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const MediaUpload = ({ onUpload, isUploading, readOnly = false }) => {
  const inputRef = useRef(null);

  return (
    <div className="tw rounded-lg border bg-card p-4">
      <div className="flex items-center justify-center">
        <div className="flex flex-col items-center gap-6">
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
          <Button
            size="lg"
            disabled={isUploading || readOnly}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            Choose Media File
          </Button>

          <p className="text-xs text-muted-foreground">
            Recommended formats: MP4, WebM, OGG, MOV (video) • MP3, WAV, M4A, AAC (audio)
          </p>
        </div>
      </div>
    </div>
  );
};
