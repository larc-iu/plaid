import React from 'react';
import { cpSlice } from '@larc-iu/plaid-client';
import { ZoomIn, ZoomOut, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useTimelineOperations } from './useTimelineOperations.js';
import { TimeAlignmentPopover } from './TimeAlignmentPopover.jsx';
import { formatTime } from './formatTime.js';
import { assignLanes } from '../../../domain/alignmentTimes.js';

// One colour per speaker, the same on every segment and in every document of
// the project: the speaker's place in the (sorted) speaker list, stepped round
// the colour wheel by the golden angle, so the first few speakers are always
// far apart. A hash of the name put "Speaker 1" and "Speaker 2" one degree
// apart. Unlabelled segments take the theme's primary colour.
const speakerHue = (speaker, speakers) => {
  const i = Math.max(0, speakers.indexOf(speaker));
  return Math.round((30 + i * 137.508) % 360);
};
const segmentColors = (speaker, speakers, resizing) => {
  if (!speaker) {
    return {
      fill: `hsl(var(--primary) / ${resizing ? 0.25 : 0.15})`,
      stroke: 'hsl(var(--primary))',
    };
  }
  const hue = speakerHue(speaker, speakers);
  return {
    fill: `hsla(${hue}, 65%, 45%, ${resizing ? 0.35 : 0.2})`,
    stroke: `hsl(${hue}, 60%, 40%)`,
  };
};

export const Timeline = ({ mediaOps, readOnly = false }) => {
  const { doc } = useDocumentCtx();

  // Drag-to-select (and the create/align popover it opens) is manual time
  // alignment — it works with no ASR service registered, so it is gated by
  // `readOnly` alone, exactly like editing/resizing existing alignments.
  const canCreateSelection = !readOnly;

  // Destructure what we need from mediaOps
  const {
    selection,
    handlePlaySelection: onPlaySelection,
    popoverOpened,
    setPopoverOpened,
    pixelsPerSecond,
  } = mediaOps;

  const currentTime = mediaOps.currentTime;
  const speakers = doc.knownSpeakers;

  // Overlapping segments (cross-talk) stack in lanes instead of painting over
  // each other; a transcript with no overlap is one full-height lane.
  const { lanes, count: laneCount } = React.useMemo(
    () => assignLanes(doc.alignmentTokens || []),
    [doc.alignmentTokens],
  );

  // Use timeline operations hook directly
  const timelineOps = useTimelineOperations(mediaOps);
  const {
    isDragging,
    tempSelection,
    waveformImage,
    isLoadingWaveform,
    isResizing,
    resizingToken,
    tempTokenBounds,
    timelineScrollLeft,
    timelineWidth,
    getVisibleTokens,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleResizeStart,
    handleSelectionCreate,
    handleAlignmentCreated,
    handlePixelsPerSecondChange,
    timelineRef,
    needleRef,
    timelineContainerRef,
    setTimelineScrollLeft,
    autoScrollToTime,
    TIMELINE_HEIGHT,
  } = timelineOps;

  const onPixelsPerSecondChange = handlePixelsPerSecondChange;

  // Register autoScrollToTime with mediaOps
  React.useEffect(() => {
    if (mediaOps.setAutoScrollToTime) {
      mediaOps.setAutoScrollToTime(autoScrollToTime);
    }
  }, [mediaOps, autoScrollToTime]);

  return (
    <TooltipProvider>
      <div className="tw rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          {/* Timeline Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">Timeline</span>
              {!readOnly && (
                <span className="text-xs text-muted-foreground">
                  Drag on the timeline to add a segment
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => {
                      // Zoom out by 1/3, minimum 4px/s
                      const newZoom = Math.max(4, pixelsPerSecond / (4 / 3));
                      onPixelsPerSecondChange(newZoom);
                    }}
                    disabled={pixelsPerSecond <= 4}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom out</TooltipContent>
              </Tooltip>
              <span className="text-sm text-muted-foreground">
                {Math.round(pixelsPerSecond)}px/s
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => {
                      // Zoom in by 1/3, max 100px/s
                      const newZoom = Math.min(100, pixelsPerSecond * (4 / 3));
                      onPixelsPerSecondChange(newZoom);
                    }}
                    disabled={pixelsPerSecond >= 100}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom in</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Timeline Visualization */}
          <div
            ref={timelineContainerRef}
            style={{
              overflowX: 'auto',
              border: '1px solid hsl(var(--border))',
              borderRadius: '4px',
              paddingTop: '50px',
            }}
            onScroll={(e) => setTimelineScrollLeft(e.target.scrollLeft)}
          >
            <div
              ref={timelineRef}
              data-timeline="track"
              style={{
                position: 'relative',
                height: `${TIMELINE_HEIGHT}px`,
                width: `${timelineWidth}px`,
                minWidth: '100%',
                cursor: !canCreateSelection ? 'default' : isDragging ? 'grabbing' : 'pointer',
                backgroundColor: 'hsl(var(--muted) / 0.5)',
                userSelect: 'none',
              }}
              onMouseDown={canCreateSelection ? handleMouseDown : undefined}
              onMouseMove={canCreateSelection ? handleMouseMove : undefined}
              onMouseUp={canCreateSelection ? handleMouseUp : undefined}
              onMouseLeave={handleMouseUp} // End drag if mouse leaves timeline
            >
              {/* Waveform Background */}
              {waveformImage && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: `${timelineWidth}px`,
                    height: `${TIMELINE_HEIGHT}px`,
                    backgroundImage: `url(${waveformImage})`,
                    backgroundRepeat: 'no-repeat',
                    backgroundSize: '100% 100%',
                    pointerEvents: 'none',
                    zIndex: 1,
                  }}
                />
              )}

              {/* Loading indicator for waveform */}
              {isLoadingWaveform && (
                <div
                  style={{
                    position: 'absolute',
                    top: '20px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    color: 'hsl(var(--muted-foreground))',
                    fontSize: '12px',
                    pointerEvents: 'none',
                  }}
                >
                  Loading waveform...
                </div>
              )}

              {/* Persistent selection highlight */}
              {selection && (
                <TimeAlignmentPopover
                  opened={popoverOpened}
                  onClose={() => setPopoverOpened(false)}
                  selection={selection}
                  onAlignmentCreated={handleAlignmentCreated}
                  selectionBox={
                    <div
                      style={{
                        position: 'absolute',
                        left: `${selection.start * pixelsPerSecond}px`,
                        width: `${(selection.end - selection.start) * pixelsPerSecond}px`,
                        top: 0,
                        bottom: 0,
                        backgroundColor: 'hsl(var(--primary) / 0.15)',
                        border: '2px solid hsl(var(--primary))',
                        pointerEvents: 'none',
                        zIndex: 4,
                      }}
                    ></div>
                  }
                />
              )}

              {/* Selection time labels and controls */}
              {selection && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${selection.start * pixelsPerSecond}px`,
                    width: `${(selection.end - selection.start) * pixelsPerSecond}px`,
                    top: '-35px',
                    height: '30px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    pointerEvents: 'auto',
                    zIndex: 15,
                  }}
                >
                  <span
                    style={{
                      color: 'hsl(var(--primary))',
                      fontWeight: 600,
                    }}
                  >
                    {formatTime(selection.start)}
                  </span>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button onClick={onPlaySelection} size="icon" className="h-7 w-7">
                        <Play className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Play selected region</TooltipContent>
                  </Tooltip>

                  <span
                    style={{
                      color: 'hsl(var(--primary))',
                      fontWeight: 600,
                    }}
                  >
                    {formatTime(selection.end)}
                  </span>
                </div>
              )}

              {/* Temporary selection highlight */}
              {tempSelection && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${tempSelection.start * pixelsPerSecond}px`,
                    width: `${(tempSelection.end - tempSelection.start) * pixelsPerSecond}px`,
                    top: 0,
                    bottom: 0,
                    backgroundColor: 'hsl(var(--primary) / 0.2)',
                    border: '1px solid hsl(var(--primary))',
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}
                />
              )}

              {/* Current time indicator */}
              <div
                ref={needleRef}
                style={{
                  position: 'absolute',
                  left: `${(currentTime || 0) * pixelsPerSecond}px`,
                  top: 0,
                  bottom: 0,
                  width: '1px',
                  backgroundColor: 'hsl(var(--destructive))',
                  pointerEvents: 'none',
                  zIndex: 10,
                }}
              />

              {/* Alignment tokens */}
              {getVisibleTokens().map((token, index) => {
                const tokenStart = token.metadata?.timeBegin || 0;
                const tokenEnd = token.metadata?.timeEnd || token.metadata?.timeBegin || 1;
                const tokenWidth = (tokenEnd - tokenStart) * pixelsPerSecond;
                const isBeingResized = isResizing && resizingToken?.id === token.id;

                // Use temp bounds if actively resizing, otherwise use current token metadata (updated optimistically)
                const displayStart = isBeingResized ? tempTokenBounds.start : tokenStart;
                const displayEnd = isBeingResized ? tempTokenBounds.end : tokenEnd;
                const displayWidth = (displayEnd - displayStart) * pixelsPerSecond;
                const speaker = token.metadata?.speaker || '';
                const colors = segmentColors(speaker, speakers, isBeingResized);
                const lane = lanes.get(token.id) ?? 0;

                return (
                  <div
                    key={token.id || index}
                    style={{
                      position: 'absolute',
                      left: `${displayStart * pixelsPerSecond}px`,
                      width: `${displayWidth}px`,
                      top: `${(lane * 100) / laneCount}%`,
                      height: `${100 / laneCount}%`,
                      backgroundColor: colors.fill,
                      border: `1px solid ${colors.stroke}`,
                      borderRadius: '0px',
                      padding: '4px 4px',
                      lineHeight: '14px',
                      fontSize: '12px',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      color: 'hsl(var(--foreground))',
                      fontWeight: 500,
                      zIndex: 3,
                    }}
                    onClick={(e) => {
                      if (isResizing) return;
                      e.stopPropagation();
                      // The transcript row is where a segment is edited: focus
                      // it (which selects and, on entry, plays the segment).
                      mediaOps.requestSegmentFocus(token.id);
                    }}
                    title={`${speaker ? speaker + ': ' : ''}${cpSlice(doc.body || '', token.begin, token.end) || ''} (${formatTime(displayStart)} - ${formatTime(displayEnd)})`}
                  >
                    {/* Speaker label (diarization) — sits in the corner over the
                      transcription; hidden on very narrow segments where there's
                      no room (the title tooltip still carries it). */}
                    {speaker && tokenWidth > 24 && (
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          maxWidth: '100%',
                          padding: '0 4px',
                          fontSize: '9px',
                          lineHeight: '13px',
                          fontWeight: 700,
                          color: '#fff',
                          backgroundColor: colors.stroke,
                          borderBottomRightRadius: '3px',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          pointerEvents: 'none',
                          zIndex: 4,
                        }}
                        title={speaker}
                      >
                        {speaker}
                      </div>
                    )}

                    {/* Left resize handle */}
                    {!readOnly && (
                      <div
                        onMouseDown={(e) => handleResizeStart(e, token, 'left')}
                        style={{
                          position: 'absolute',
                          left: '-2px',
                          top: 0,
                          bottom: 0,
                          width: '4px',
                          backgroundColor: colors.stroke,
                          cursor: 'ew-resize',
                          zIndex: 5,
                          opacity: tokenWidth > 20 ? 1 : 0, // Hide on very small tokens
                        }}
                      />
                    )}

                    {/* Token content */}
                    <div
                      style={{
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: tokenWidth > 20 ? '6px' : '2px',
                        paddingRight: tokenWidth > 20 ? '6px' : '2px',
                      }}
                    >
                      {cpSlice(doc.body || '', token.begin, token.end) || ''}
                    </div>

                    {/* Right resize handle */}
                    {!readOnly && (
                      <div
                        onMouseDown={(e) => handleResizeStart(e, token, 'right')}
                        style={{
                          position: 'absolute',
                          right: '-2px',
                          top: 0,
                          bottom: 0,
                          width: '4px',
                          backgroundColor: colors.stroke,
                          cursor: 'ew-resize',
                          zIndex: 5,
                          opacity: tokenWidth > 20 ? 1 : 0, // Hide on very small tokens
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};
