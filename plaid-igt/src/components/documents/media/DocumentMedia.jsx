import React from 'react';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { useMediaOperations } from './useMediaOperations.js';
import { MediaPlayer } from './MediaPlayer.jsx';
import { Timeline } from './Timeline.jsx';
import { TranscriptList } from './TranscriptList.jsx';
import { useServerLimits } from '@/hooks/useServerLimits';
import { MediaUpload } from './MediaUpload.jsx';
import { TranscribeDialog } from './TranscribeDialog.jsx';
import { Button } from '@ui/components/ui/button';
import { DeleteSegmentsDialog } from './DeleteSegmentsDialog.jsx';

export function DocumentMedia() {
  const { doc, readOnly, canWrite, writeLock } = useDocumentCtx();
  useIgtDocument(doc);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // Use media operations hook
  const mediaOps = useMediaOperations();
  const limits = useServerLimits();

  // If no media, show upload interface
  if (!doc.document.mediaUrl) {
    return (
      <div className="flex flex-col gap-6">
        <MediaUpload
          onUpload={mediaOps.handleMediaUpload}
          isUploading={mediaOps.isUploading}
          progress={mediaOps.uploadProgress}
          convertProgress={mediaOps.convertProgress}
          maxBytes={limits?.mediaFileBytes ?? null}
          readOnly={readOnly}
        />
      </div>
    );
  }

  return (
    // pb-24: room under the transcript for a popover anchored near the bottom
    // of the timeline, which would otherwise have nowhere to open into.
    <div className="flex flex-col gap-6 pb-24">
      {/* Media Player. Speech detection sits in its header: it acts on the
          recording, and its proposals surface on the timeline and transcript. */}
      <MediaPlayer mediaOps={mediaOps} readOnly={readOnly} canWrite={canWrite} />

      {/* Timeline */}
      <div className="relative">
        <Timeline mediaOps={mediaOps} readOnly={readOnly} />
      </div>

      {/* Transcript: the segments as rows, for transcribing by ear. Transcribe
          and Clear segments live in its header, beside what they change. */}
      <TranscriptList
        mediaOps={mediaOps}
        readOnly={readOnly}
        headerActions={
          // canWrite, not readOnly: Transcribe carries its own run's progress.
          !canWrite ? null : (
            <>
              <TranscribeDialog mediaOps={mediaOps} readOnly={readOnly} />
              <Button
                variant="outline"
                onClick={() => setDeleteOpen(true)}
                disabled={
                  mediaOps.isProcessing ||
                  mediaOps.isUploading ||
                  !!writeLock ||
                  !mediaOps.alignmentTokens.length
                }
              >
                Delete segments
              </Button>
            </>
          )
        }
      />
      <DeleteSegmentsDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        doc={doc}
        alignmentTokens={mediaOps.alignmentTokens}
      />
    </div>
  );
}
