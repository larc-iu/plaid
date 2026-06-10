import React from 'react';
import { Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { useMediaOperations } from './useMediaOperations.js';
import { MediaPlayer } from './MediaPlayer.jsx';
import { Timeline } from './Timeline.jsx';
import { MediaUpload } from './MediaUpload.jsx';
import { ServiceSummary } from '../services/ServiceSummary.jsx';
import { ServiceParamForm } from '../services/ServiceParamForm.jsx';

export function DocumentMedia() {
  const { doc, readOnly } = useDocumentCtx();
  useIgtDocument(doc);

  // Use media operations hook
  const mediaOps = useMediaOperations();

  // Manual alignment (drag on the timeline) always works; automatic
  // transcription additionally needs a registered ASR service.
  const asrAvailable = mediaOps.asrAlgorithmOptions.length > 0;

  // If no media, show upload interface
  if (!doc.document.mediaUrl) {
    return (
      <div className="tw flex flex-col gap-6">
        <MediaUpload
          onUpload={mediaOps.handleMediaUpload}
          isUploading={mediaOps.isUploading}
          readOnly={readOnly}
        />
      </div>
    );
  }

  return (
    <div className="tw flex flex-col gap-6" style={{ marginBottom: '400px' }}>
      {/* Media Player */}
      <MediaPlayer mediaOps={mediaOps} readOnly={readOnly} />

      {/* Timeline */}
      <div className="relative">
        <Timeline
          mediaOps={mediaOps}
          readOnly={readOnly}
        />
      </div>

      {/* ASR Controls */}
      <div className="rounded-lg border bg-muted/50 p-4">
        <div className="mb-4 flex items-end justify-between">
          <div className="flex items-end gap-2">
            <div
              className="flex flex-col gap-1.5"
              onMouseEnter={mediaOps.handleAsrDropdownInteraction}
            >
              <div className="flex items-center gap-1.5">
                <Label>Transcription Service</Label>
                <ServiceSummary service={mediaOps.selectedService} />
              </div>
              <Select
                value={mediaOps.asrAlgorithm}
                onValueChange={mediaOps.handleAlgorithmChange}
                disabled={readOnly || !asrAvailable}
              >
                <SelectTrigger className="w-[280px]">
                  <SelectValue placeholder={asrAvailable ? 'Choose a service' : 'No service registered'} />
                </SelectTrigger>
                <SelectContent>
                  {mediaOps.asrAlgorithmOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
                onClick={mediaOps.handleTranscribe}
                disabled={!mediaOps.isUsingAsrService || mediaOps.isProcessing || mediaOps.isUploading || readOnly || Object.keys(mediaOps.paramErrors || {}).length > 0}
            >
              <Mic className="h-4 w-4" />
              {mediaOps.isProcessing ? 'Transcribing…' : 'Transcribe'}
            </Button>
          </div>

          <Button
              variant="outline"
              onClick={mediaOps.handleClearAlignments}
              disabled={mediaOps.isProcessing || mediaOps.isUploading || !mediaOps.alignmentTokens.length || readOnly}
          >
            Clear Alignments
          </Button>
        </div>

        {/* Service arguments (only when a service with parameters is selected) */}
        {mediaOps.paramSchema?.length > 0 && (
          <div className="mb-4">
            <ServiceParamForm
              schema={mediaOps.paramSchema}
              values={mediaOps.paramValues}
              errors={mediaOps.paramErrors}
              onChange={mediaOps.setParamValue}
              disabled={readOnly || mediaOps.isProcessing || mediaOps.isUploading}
            />
          </div>
        )}

        {/* Progress */}
        <div style={{ minHeight: '80px' }}>
          {(mediaOps.isProcessing || mediaOps.isUploading) ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Mic className="h-4 w-4" />
                <span className="font-medium">{mediaOps.progressMessage || 'Processing...'}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${mediaOps.progressPercent || mediaOps.transcriptionProgress}%` }}
                />
              </div>
              <span className="text-sm text-muted-foreground">{mediaOps.currentOperation}</span>
            </div>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="text-sm text-muted-foreground">
                {mediaOps.alignmentTokens.length > 0
                  ? `${mediaOps.alignmentTokens.length} time alignments`
                  : 'No time alignments yet'
                }
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
