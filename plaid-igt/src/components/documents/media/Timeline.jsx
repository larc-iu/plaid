import React from 'react';
import { cpSlice } from '@larc-iu/plaid-client';
import { ZoomIn, ZoomOut, Play, Pause, Scissors, FoldHorizontal } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@ui/components/ui/tooltip';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useTimelineOperations, clampZoom, MIN_ZOOM, MAX_ZOOM } from './useTimelineOperations.js';
import { drawWaveform } from './useWaveform.js';
import { TIMELINE_HEIGHT as TRACK_HEIGHT } from './waveform.js';
import { TimeAlignmentPopover } from './TimeAlignmentPopover.jsx';
import { formatTime } from './formatTime.js';
import { TimeRuler, RULER_BAND } from './TimeRuler.jsx';
import { assignLanes } from '../../../domain/alignmentTimes.js';
import { stableKey } from '@ui/domain/pendingIds.js';
import { keys } from '@/lib/keymap.js';
import { caretInRow } from './segmentCaret.js';

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
      stroke: 'hsl(var(--primary) / 0.45)',
    };
  }
  const hue = speakerHue(speaker, speakers);
  return {
    fill: `hsla(${hue}, 65%, 45%, ${resizing ? 0.35 : 0.2})`,
    stroke: `hsl(${hue}, 60%, 40%)`,
  };
};

// Exactly the recording's length at this zoom, where the track itself may be
// stretched to fill the box: what is placed as a share of the recording is
// placed inside one of these. It takes no pointer itself, so a press on it is
// a press on the track.
const ScaleLayer = ({ width, children }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: `${width}px`,
      pointerEvents: 'none',
    }}
  >
    {children}
  </div>
);

// The waveform for one stretch of the recording, drawn straight onto the
// canvas whenever the stretch or the zoom changes. Between a zoom and its
// redraw the old picture is stretched to the new width, since its box is a
// share of the track.
const WaveformCanvas = ({ envelope, from, to, duration, pixelsPerSecond }) => {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    drawWaveform(ref.current, envelope, { from, to, duration, pixelsPerSecond });
  }, [envelope, from, to, duration, pixelsPerSecond]);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        left: `${(from / duration) * 100}%`,
        width: `${((to - from) / duration) * 100}%`,
        height: '100%',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  );
};

// How far the selection's ring stands outside its box (a 1px gap and a 2px
// ring), so the bracket above meets the ring and not the box inside it.
const RING_OUTSET = 3;

// The selection's times and its play button, in the strip above the track.
// One small card centred over the selection, tied to it by a stem and a
// bracket the selection's width, so it reads as the selection's at any width:
// over a sliver the bracket closes to a single tick under the stem.
//
// Zoomed in, the selection can be partly scrolled out of the box. The stem
// then stands over the middle of the part in view and the card slides to
// stay in view (and inside the recording), so the times are never scrolled
// away while some of the selection is still on screen. Placed from the scroll
// box on every scroll, by CSS variables and not by React, since a render per
// scroll frame is what the timeline's perf work took out. A selection wholly
// out of view takes its card with it.
const SelectionReadout = ({
  selection,
  pixelsPerSecond,
  trackWidth,
  lane,
  laneCount,
  playing,
  onPlay,
  segmentId = null,
  onSplit = null,
  onMerge = null,
}) => {
  // Where the caret was in the segment's row when a button was pressed: the
  // press takes focus from the row before the click, and a split cuts the
  // text there.
  const caretRef = React.useRef(null);
  const left = selection.start * pixelsPerSecond - RING_OUTSET;
  const width = (selection.end - selection.start) * pixelsPerSecond + 2 * RING_OUTSET;
  const mid = left + width / 2;
  // A selected cross-talk segment's ring is round its own lane only, so the
  // bracket's ticks run down to the top of that lane's ring.
  const ringTop = lane > 0 ? (lane * TRACK_HEIGHT) / laneCount - RING_OUTSET : 0;
  const line = 'hsl(var(--ring))';
  const rootRef = React.useRef(null);
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    // The readout sits in the track, and the track in the scrolling box.
    const box = root?.parentElement?.parentElement;
    if (!root || !box) return undefined;
    const place = () => {
      const viewLeft = box.scrollLeft;
      const viewRight = viewLeft + box.clientWidth;
      const from = Math.max(left, viewLeft);
      const to = Math.min(left + width, viewRight);
      const inView = to > from;
      root.style.setProperty('--stem', `${Math.round(inView ? (from + to) / 2 : mid)}px`);
      root.style.setProperty('--lo', `${inView ? Math.max(0, viewLeft) : 0}px`);
      root.style.setProperty('--hi', `${inView ? Math.min(trackWidth, viewRight) : trackWidth}px`);
    };
    place();
    box.addEventListener('scroll', place, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(box);
    return () => {
      box.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [left, width, mid, trackWidth]);
  return (
    <div
      ref={rootRef}
      data-selection-readout=""
      // Part of the track's box but not of its gestures: a press here is
      // never the start of a drag.
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: `${left}px`,
          width: `${width}px`,
          top: '-7px',
          height: `${7 + ringTop}px`,
          borderTop: `1px solid ${line}`,
          borderLeft: `1px solid ${line}`,
          borderRight: `1px solid ${line}`,
          pointerEvents: 'none',
          zIndex: 15,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 'var(--stem)',
          width: '1px',
          top: '-14px',
          height: '7px',
          backgroundColor: line,
          pointerEvents: 'none',
          zIndex: 15,
        }}
      />
      <div
        className="flex h-7 items-center gap-1 whitespace-nowrap rounded-md border bg-card pl-0.5 pr-2 shadow-sm"
        style={{
          position: 'absolute',
          top: '-42px',
          left: 'var(--stem)',
          transform:
            'translateX(clamp(calc(var(--lo) - var(--stem)), -50%, calc(var(--hi) - var(--stem) - 100%)))',
          zIndex: 16,
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={playing ? 'Pause selection' : 'Play selection'}
              onClick={onPlay}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{playing ? 'Pause' : 'Play selection'}</TooltipContent>
        </Tooltip>
        <span className="font-mono text-[11px] tabular-nums text-foreground">
          {formatTime(selection.start)}
          <span className="px-1 text-muted-foreground">–</span>
          {formatTime(selection.end)}
        </span>
        {segmentId != null && onSplit && (
          <>
            <span aria-hidden="true" className="ml-1 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label="Split segment"
                  onMouseDown={() => {
                    caretRef.current = caretInRow(document.activeElement, segmentId);
                  }}
                  onClick={() => {
                    const offset = caretRef.current;
                    caretRef.current = null;
                    onSplit(segmentId, offset);
                  }}
                >
                  <Scissors className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Split at playback · {keys.words('media.split')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-1 h-6 w-6"
                  aria-label="Merge with next segment"
                  onClick={() => onMerge(segmentId)}
                >
                  <FoldHorizontal className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Merge with next · {keys.words('media.merge')}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
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
    isPlaying,
    playingSelection,
  } = mediaOps;
  const selectionPlaying =
    !!selection &&
    isPlaying &&
    playingSelection?.start === selection.start &&
    playingSelection?.end === selection.end;

  const speakers = doc.knownSpeakers;

  // Overlapping segments (cross-talk) stack in lanes instead of painting over
  // each other; a transcript with no overlap is one full-height lane.
  const { lanes, count: laneCount } = React.useMemo(
    () => assignLanes(doc.alignmentTokens || []),
    [doc.alignmentTokens],
  );
  // The lane of the segment the selection is, when there are lanes and the
  // selection is exactly one segment: its ring then goes round that lane
  // only, not the other speaker's.
  const selectedSegment = React.useMemo(() => {
    if (!selection) return null;
    const hits = (doc.alignmentTokens || []).filter(
      (t) => t.metadata?.timeBegin === selection.start && t.metadata?.timeEnd === selection.end,
    );
    return hits.length === 1 ? hits[0] : null;
  }, [selection, doc.alignmentTokens]);
  const selectionLane =
    selectedSegment && laneCount > 1 ? (lanes.get(selectedSegment.id) ?? null) : null;

  // Use timeline operations hook directly
  const timelineOps = useTimelineOperations(mediaOps);
  const { drawn } = timelineOps;
  const duration = mediaOps.duration;

  const proposals = mediaOps.vad?.proposals;
  const requestSegmentFocus = mediaOps.requestSegmentFocus;
  // Placed as shares of the recording rather than in pixels, so a zoom, which
  // only changes the track's width, re-renders none of them.
  const proposalBlocks = React.useMemo(
    () =>
      !duration
        ? null
        : (proposals || [])
            .filter((p) => p.timeEnd >= drawn.from && p.timeBegin <= drawn.to)
            .map((p) => (
              <div
                key={p.id}
                data-vad-proposal={p.id}
                style={{
                  position: 'absolute',
                  left: `${(p.timeBegin / duration) * 100}%`,
                  width: `max(1px, ${((p.timeEnd - p.timeBegin) / duration) * 100}%)`,
                  top: 0,
                  bottom: 0,
                  backgroundColor: 'hsl(var(--primary) / 0.06)',
                  border: '1px dashed hsl(var(--primary) / 0.7)',
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                  zIndex: 2,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  requestSegmentFocus(p.id);
                }}
                title={`Proposed segment (${formatTime(p.timeBegin)} - ${formatTime(p.timeEnd)})`}
              />
            )),
    [proposals, drawn, duration, requestSegmentFocus],
  );

  const {
    isDragging,
    tempSelection,
    waveformEnvelope,
    isLoadingWaveform,
    isResizing,
    resizingToken,
    tempTokenBounds,
    timelineWidth,
    getVisibleTokens,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleResizeStart,
    handleAlignmentCreated,
    timelineRef,
    needleRef,
    attachTimelineContainer,
    handleTimelineScroll,
    autoScrollToTime,
    TIMELINE_HEIGHT,
  } = timelineOps;

  const onPixelsPerSecondChange = timelineOps.zoomTo;
  const { fitToWidth } = timelineOps;

  // Open on the view this document was left at, or the whole recording
  // fitted to the lane, once, when the duration first arrives. Not on every
  // duration change and never after a person has zoomed themselves: `opened`
  // remembers which recording was opened. Leaving the tab unmounts all of
  // this, and the view comes back from where it was kept (timelineView.js).
  const { openView } = timelineOps;
  const opened = React.useRef(null);
  React.useEffect(() => {
    const duration = mediaOps.duration;
    if (!duration || opened.current === duration) return;
    if (openView() !== null) opened.current = duration;
  }, [mediaOps.duration, openView]);

  // Register autoScrollToTime with mediaOps
  React.useEffect(() => {
    if (mediaOps.setAutoScrollToTime) {
      mediaOps.setAutoScrollToTime(autoScrollToTime);
    }
  }, [mediaOps, autoScrollToTime]);

  return (
    <TooltipProvider>
      <div className="rounded-lg border bg-card p-4">
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
                    onClick={() => onPixelsPerSecondChange(clampZoom(pixelsPerSecond / (4 / 3)))}
                    disabled={pixelsPerSecond <= MIN_ZOOM}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom out</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-sm font-normal text-muted-foreground"
                    onClick={fitToWidth}
                  >
                    {Math.round(pixelsPerSecond)}px/s
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Fit the recording to the width</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => onPixelsPerSecondChange(clampZoom(pixelsPerSecond * (4 / 3)))}
                    disabled={pixelsPerSecond >= MAX_ZOOM}
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
            ref={attachTimelineContainer}
            style={{
              overflowX: 'auto',
              border: '1px solid hsl(var(--border))',
              borderRadius: '4px',
              paddingTop: `${RULER_BAND}px`,
            }}
            onScroll={handleTimelineScroll}
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
              <TimeRuler
                from={drawn.from}
                to={drawn.to}
                duration={duration}
                pixelsPerSecond={pixelsPerSecond}
                clear={selection}
              />

              {/* Waveform, for the drawn stretch only, so it stays sharp at
                  every zoom on a recording of any length. */}
              {waveformEnvelope && duration > 0 && (
                <ScaleLayer width={timelineWidth}>
                  <WaveformCanvas
                    envelope={waveformEnvelope}
                    from={drawn.from}
                    to={drawn.to}
                    duration={duration}
                    pixelsPerSecond={pixelsPerSecond}
                  />
                </ScaleLayer>
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
                  Loading waveform…
                </div>
              )}

              {/* Persistent selection highlight */}
              {selection && (
                <TimeAlignmentPopover
                  open={popoverOpened}
                  onOpenChange={setPopoverOpened}
                  selection={selection}
                  onAlignmentCreated={handleAlignmentCreated}
                  selectionBox={
                    <div
                      style={{
                        position: 'absolute',
                        left: `${selection.start * pixelsPerSecond}px`,
                        width: `${Math.max(1, (selection.end - selection.start) * pixelsPerSecond)}px`,
                        top: selectionLane === null ? 0 : `${(selectionLane * 100) / laneCount}%`,
                        height: selectionLane === null ? '100%' : `${100 / laneCount}%`,
                        backgroundColor: 'hsl(var(--primary) / 0.08)',
                        // A ring outside the box, clear of the segment borders
                        // it sits on, as a focus ring stands clear of a field.
                        boxShadow: `0 0 0 1px hsl(var(--card)), 0 0 0 ${RING_OUTSET}px hsl(var(--ring))`,
                        pointerEvents: 'none',
                        zIndex: 4,
                      }}
                    ></div>
                  }
                />
              )}

              {selection && (
                <SelectionReadout
                  selection={selection}
                  pixelsPerSecond={pixelsPerSecond}
                  trackWidth={timelineWidth}
                  lane={selectionLane ?? 0}
                  laneCount={laneCount}
                  playing={selectionPlaying}
                  onPlay={onPlaySelection}
                  segmentId={readOnly ? null : (selectedSegment?.id ?? null)}
                  onSplit={(id, offset) => mediaOps.handleSplitSegment(id, { offset })}
                  onMerge={mediaOps.handleMergeSegment}
                />
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
                // Placed by the clock (useTimelineOperations), never here.
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: '1px',
                  backgroundColor: 'hsl(var(--destructive))',
                  pointerEvents: 'none',
                  willChange: 'transform',
                  zIndex: 10,
                }}
              />

              {/* Proposed segments from speech detection. Not data: they hold
                  no text, nothing has been written, and one becomes a real
                  segment only when it is typed into. Drawn behind the real
                  ones, outlined rather than filled, so the difference is
                  visible at a glance. Memoized so the playhead moving does not
                  re-render a long recording's worth of them. */}
              <ScaleLayer width={timelineWidth}>{proposalBlocks}</ScaleLayer>

              {/* Alignment tokens */}
              {getVisibleTokens().map((token) => {
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
                // The edges are drawn only under the pointer or mid-drag: drawn
                // on every segment they were a heavy bar between every pair,
                // and the pointer's resize cursor finds them anyway. Never on a
                // sliver, where they would cover it.
                // Inside the segment, which clips what overhangs it: a handle
                // half outside was a 2px target.
                const grip = tokenWidth > 20 ? 6 : 3;
                const handleClass =
                  tokenWidth <= 20
                    ? 'opacity-0'
                    : isBeingResized
                      ? ''
                      : 'opacity-0 transition-opacity group-hover:opacity-100';

                return (
                  <div
                    key={stableKey(token.id)}
                    className="group"
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
                        className={handleClass}
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${grip}px`,
                          boxShadow: `inset 3px 0 0 ${colors.stroke}`,
                          cursor: 'ew-resize',
                          zIndex: 5,
                        }}
                      />
                    )}

                    {/* Token content */}
                    <div
                      dir="auto"
                      className="font-text"
                      style={{
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: tokenWidth > 20 ? '6px' : '2px',
                        paddingRight: tokenWidth > 20 ? '6px' : '2px',
                        // A halo in the card's colour, so the words read over
                        // the waveform drawn behind them.
                        textShadow:
                          '0 0 2px hsl(var(--card)), 0 0 2px hsl(var(--card)), 0 0 1px hsl(var(--card))',
                      }}
                    >
                      {cpSlice(doc.body || '', token.begin, token.end) || ''}
                    </div>

                    {/* Right resize handle */}
                    {!readOnly && (
                      <div
                        onMouseDown={(e) => handleResizeStart(e, token, 'right')}
                        className={handleClass}
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: `${grip}px`,
                          boxShadow: `inset -3px 0 0 ${colors.stroke}`,
                          cursor: 'ew-resize',
                          zIndex: 5,
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
