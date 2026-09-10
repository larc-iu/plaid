import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { clampResize } from '../../../domain/alignmentTimes.js';
import { useWaveform } from './useWaveform.js';

// Constants
const TIMELINE_HEIGHT = 100;
// A wheel event in line mode (Firefox, some Windows mice) reports lines, not
// pixels. Roughly one text line.
const WHEEL_LINE_HEIGHT = 16;

export const useTimelineOperations = (mediaOps) => {
  const doc = mediaOps.doc;
  const mediaElement = mediaOps.mediaElementRef.current;

  // Local timeline state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [tempSelection, setTempSelection] = useState(null);

  // Resize state management
  const [isResizing, setIsResizing] = useState(false);
  const [resizingToken, setResizingToken] = useState(null);
  const [resizingHandle, setResizingHandle] = useState(null); // 'left' or 'right'
  const [tempTokenBounds, setTempTokenBounds] = useState(null);

  // Virtualization state
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);

  // Refs
  const timelineRef = useRef(null);
  const needleRef = useRef(null);
  const timelineContainerRef = useRef(null);
  const animationFrameRef = useRef(null);
  // Pending zoom-to-pointer anchor. Set by the ctrl+wheel handler, consumed by a
  // layout effect once the new pixelsPerSecond (and thus the timeline width) has
  // committed — see the wheel handler below.
  const zoomAnchorRef = useRef(null);

  // Zoom and timeline calculations
  const timelineWidth = mediaOps.duration * mediaOps.pixelsPerSecond;

  const handlePixelsPerSecondChange = useCallback(
    (newPixelsPerSecond) => {
      mediaOps.setPixelsPerSecond(newPixelsPerSecond);
    },
    [mediaOps],
  );

  // The zoom buttons, anchored the way ctrl+wheel is anchored on the pointer:
  // on the playhead when it is on screen, since clicking a segment moves
  // playback to it and that is the segment the person is looking at, else on
  // the middle of the view. Without an anchor the scroll offset stayed put in
  // pixels and the segment being worked on slid off the screen.
  const zoomTo = useCallback(
    (newPixelsPerSecond) => {
      const container = timelineContainerRef.current;
      const old = mediaOps.pixelsPerSecond;
      if (container && old > 0) {
        const width = container.clientWidth;
        const needleX = (mediaOps.currentTime ?? 0) * old - container.scrollLeft;
        const anchorX = needleX >= 0 && needleX <= width ? needleX : width / 2;
        zoomAnchorRef.current = {
          timeAtPointer: (container.scrollLeft + anchorX) / old,
          pointerX: anchorX,
        };
      }
      handlePixelsPerSecondChange(newPixelsPerSecond);
    },
    [mediaOps.pixelsPerSecond, mediaOps.currentTime, handlePixelsPerSecondChange],
  );

  // Calculate visible tokens for virtualization
  const getVisibleTokens = useCallback(() => {
    if (!timelineContainerRef.current || !mediaOps.duration || mediaOps.pixelsPerSecond <= 0) {
      return doc.alignmentTokens || [];
    }

    const containerWidth = timelineContainerRef.current.clientWidth;
    const scrollLeft = timelineScrollLeft;

    // Calculate visible time range with buffer
    const bufferTime = 10; // seconds of buffer on each side
    const visibleTimeStart = Math.max(0, scrollLeft / mediaOps.pixelsPerSecond - bufferTime);
    const visibleTimeEnd = Math.min(
      mediaOps.duration,
      (scrollLeft + containerWidth) / mediaOps.pixelsPerSecond + bufferTime,
    );

    // Filter tokens that intersect with visible range
    return (doc.alignmentTokens || []).filter((token) => {
      const tokenStart = token.metadata?.timeBegin || 0;
      const tokenEnd = token.metadata?.timeEnd || token.metadata?.timeBegin || 1;

      // Check if token intersects with visible range
      return tokenEnd >= visibleTimeStart && tokenStart <= visibleTimeEnd;
    });
  }, [
    timelineContainerRef,
    mediaOps.duration,
    mediaOps.pixelsPerSecond,
    timelineScrollLeft,
    doc.alignmentTokens,
  ]);

  const getTimeFromPosition = useCallback(
    (clientX) => {
      if (!timelineRef.current) return 0;
      const rect = timelineRef.current.getBoundingClientRect();
      const clickX = clientX - rect.left;
      const timeAtClick = clickX / mediaOps.pixelsPerSecond;
      return Math.max(0, Math.min(mediaOps.duration, timeAtClick));
    },
    [mediaOps.pixelsPerSecond, mediaOps.duration],
  );

  // Helper function to auto-scroll timeline to show current position
  const autoScrollToTime = useCallback(
    (time) => {
      if (timelineContainerRef.current && mediaOps.pixelsPerSecond > 0) {
        const position = time * mediaOps.pixelsPerSecond;
        const containerWidth = timelineContainerRef.current.clientWidth;
        const scrollLeft = position - containerWidth / 2; // Center the position
        timelineContainerRef.current.scrollLeft = Math.max(0, scrollLeft);
      }
    },
    [mediaOps.pixelsPerSecond],
  );

  // Timeline interaction handlers
  const handleTimelineClick = useCallback(
    (time) => {
      if (mediaElement) {
        // A seek moves playback and leaves it running or paused as it was;
        // a transcriber scrubbing back to re-hear a stretch wants it to keep going.
        mediaElement.currentTime = time;
        mediaOps.setCurrentTime(time); // Update state immediately
        mediaOps.setPlayingSelection(null);

        // A click inside a dragged stretch reopens its popover. A selection that
        // is an existing segment (a row was entered) belongs to the transcript,
        // not to the popover, which only makes new segments.
        const sel = mediaOps.selection;
        const isSegment =
          sel &&
          (doc.alignmentTokens || []).some(
            (t) => t.metadata?.timeBegin === sel.start && t.metadata?.timeEnd === sel.end,
          );
        if (sel && time >= sel.start && time <= sel.end && !mediaOps.popoverOpened && !isSegment) {
          mediaOps.setPopoverOpened(true);
        }
      }
    },
    [mediaElement, mediaOps, doc],
  );

  const handleSelectionCreate = useCallback(
    (startTime, endTime) => {
      const newSelection = { start: startTime, end: endTime };
      mediaOps.setSelection(newSelection);
      mediaOps.setPopoverOpened(true); // Open popover immediately when selection is created
    },
    [mediaOps],
  );

  // After a segment is made or trimmed: drop the selection and the popover.
  // No reload: the mutations patch the document in place.
  const handleAlignmentCreated = useCallback(async () => {
    mediaOps.setSelection(null);
    mediaOps.setPopoverOpened(false);
  }, [mediaOps]);

  // Mouse event handlers for timeline
  const handleMouseDown = useCallback(
    (event) => {
      if (event.button !== 0) return; // Only left mouse button
      if (isResizing) return; // Don't start new drag while resizing

      const time = getTimeFromPosition(event.clientX);

      // Only close popover if clicking outside existing selection
      if (!mediaOps.selection || time < mediaOps.selection.start || time > mediaOps.selection.end) {
        mediaOps.setPopoverOpened(false);
      }

      setIsDragging(true);
      setDragStart(time);
      setDragEnd(time);
      setTempSelection(null);
    },
    [isResizing, getTimeFromPosition, mediaOps],
  );

  // Resize event handlers (defined first to avoid reference issues)
  const handleResizeStart = useCallback((event, token, handle) => {
    event.stopPropagation();
    event.preventDefault();

    setIsResizing(true);
    setResizingToken(token);
    setResizingHandle(handle);
    setTempTokenBounds({
      start: token.metadata?.timeBegin || 0,
      end: token.metadata?.timeEnd || 0,
    });
  }, []);

  const handleResizeMove = useCallback(
    (event) => {
      if (!isResizing || !resizingToken) return;

      const currentTime = getTimeFromPosition(event.clientX);

      setTempTokenBounds((prevBounds) => {
        if (!prevBounds) return prevBounds;

        let newStart = prevBounds.start;
        let newEnd = prevBounds.end;

        // An edge stops at the recording's ends, 0.1 s short of the segment's
        // other edge, and at any segment it may not overlap (alignmentTimes).
        const clamped = clampResize(
          doc.alignmentTokens || [],
          resizingToken.id,
          resizingHandle,
          currentTime,
          { duration: mediaOps.duration },
        );
        if (resizingHandle === 'left') newStart = clamped;
        else if (resizingHandle === 'right') newEnd = clamped;

        return { start: newStart, end: newEnd };
      });
    },
    [isResizing, resizingToken, resizingHandle, getTimeFromPosition, mediaOps.duration, doc],
  );

  const handleResizeEnd = useCallback(
    async (event) => {
      if (!isResizing || !resizingToken || !tempTokenBounds) return;

      try {
        // The domain method does the optimistic patch + reload-on-error.
        await doc.updateAlignmentBounds(resizingToken.id, {
          timeBegin: tempTokenBounds.start,
          timeEnd: tempTokenBounds.end,
        });

        // Clear selection state
        handleAlignmentCreated();
      } finally {
        // Reset resize state
        setIsResizing(false);
        setResizingToken(null);
        setResizingHandle(null);
        setTempTokenBounds(null);
      }
    },
    [isResizing, resizingToken, tempTokenBounds, doc, handleAlignmentCreated],
  );

  const handleMouseMove = useCallback(
    (event) => {
      if (isResizing) {
        handleResizeMove(event);
        return;
      }

      if (!isDragging) return;

      const time = getTimeFromPosition(event.clientX);
      setDragEnd(time);

      // Create temporary selection for visual feedback
      const start = Math.min(dragStart, time);
      const end = Math.max(dragStart, time);
      setTempSelection({ start, end });
    },
    [isResizing, isDragging, getTimeFromPosition, dragStart, handleResizeMove],
  );

  const handleMouseUp = useCallback(
    (event) => {
      // During resize, the global event handler handles mouseup to avoid double calls
      if (isResizing) {
        return;
      }

      if (!isDragging) return;

      const time = getTimeFromPosition(event.clientX);
      const start = Math.min(dragStart, time);
      const end = Math.max(dragStart, time);

      setIsDragging(false);
      setTempSelection(null);

      // If it's just a click (very small selection), seek to that time
      if (Math.abs(end - start) < 0.1) {
        handleTimelineClick(start);
      } else {
        // If it's a proper selection, create a time range for annotation
        handleSelectionCreate(start, end);
      }

      setDragStart(null);
      setDragEnd(null);
    },
    [
      isResizing,
      isDragging,
      getTimeFromPosition,
      dragStart,
      handleTimelineClick,
      handleSelectionCreate,
      handleResizeEnd,
    ],
  );

  // Global mouse event listeners for resize
  useEffect(() => {
    if (!isResizing) return;

    const handleGlobalMouseMove = (event) => {
      handleResizeMove(event);
    };

    const handleGlobalMouseUp = (event) => {
      handleResizeEnd(event);
    };

    // Add global listeners
    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    // Cleanup
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  // Handle wheel events with proper passive listener setup
  useEffect(() => {
    const container = timelineContainerRef.current;
    if (!container) return;

    const handleWheel = (event) => {
      event.preventDefault();

      if (event.ctrlKey || event.metaKey) {
        // CTRL+scroll: zoom in/out (modify pixels per second)
        const oldPixelsPerSecond = mediaOps.pixelsPerSecond;
        const delta = event.deltaY > 0 ? -1 : 1; // Reverse for natural zooming
        const zoomFactor = 1.1;
        const newPixelsPerSecond =
          delta > 0
            ? Math.min(100, oldPixelsPerSecond * zoomFactor)
            : Math.max(4, oldPixelsPerSecond / zoomFactor);
        if (newPixelsPerSecond !== oldPixelsPerSecond) {
          // Zoom anchored at the pointer: remember the time step currently under
          // the cursor and its pixel offset inside the scroll viewport. The
          // layout effect below restores that time step to the same offset once
          // the new width has committed, so the cursor stays put while zooming.
          const rect = container.getBoundingClientRect();
          const pointerX = event.clientX - rect.left;
          zoomAnchorRef.current = {
            timeAtPointer: (container.scrollLeft + pointerX) / oldPixelsPerSecond,
            pointerX,
          };
          handlePixelsPerSecondChange(newPixelsPerSecond);
        }
      } else {
        // Pan left/right by the distance the gesture reports.
        //
        // A trackpad swipe carries BOTH axes and a mouse wheel only deltaY, so
        // whichever is larger is the one the hand meant. Reading deltaY alone
        // through `deltaY > 0 ? +50 : -50` made every horizontal swipe on a
        // Mac, where deltaY is then 0, take the negative branch: the timeline
        // crawled to 0:00 whichever way the fingers went.
        const scale =
          event.deltaMode === 1
            ? WHEEL_LINE_HEIGHT
            : event.deltaMode === 2
              ? container.clientWidth
              : 1;
        const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        container.scrollLeft += raw * scale;
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [mediaOps.pixelsPerSecond, handlePixelsPerSecondChange]);

  // Apply a pending zoom-to-pointer anchor after the new pixelsPerSecond (and
  // therefore the timeline width) has committed to the DOM. Keeping the time
  // step that was under the cursor pinned to the same viewport offset makes
  // ctrl+wheel zoom feel anchored instead of jumping back toward t=0.
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const container = timelineContainerRef.current;
    if (!container) return;
    const nextScrollLeft = Math.max(
      0,
      anchor.timeAtPointer * mediaOps.pixelsPerSecond - anchor.pointerX,
    );
    container.scrollLeft = nextScrollLeft;
    setTimelineScrollLeft(nextScrollLeft);
  }, [mediaOps.pixelsPerSecond]);

  // Smooth needle movement with auto-scroll
  useEffect(() => {
    const updateNeedle = () => {
      if (
        needleRef.current &&
        timelineRef.current &&
        mediaElement &&
        mediaOps.pixelsPerSecond > 0
      ) {
        const currentTime = mediaElement.currentTime;
        const position = currentTime * mediaOps.pixelsPerSecond;
        needleRef.current.style.left = `${position}px`;

        // Auto-scroll to keep needle in view
        const timelineContainer = timelineContainerRef.current; // The scrollable Box
        if (timelineContainer) {
          const containerWidth = timelineContainer.clientWidth;
          const scrollLeft = timelineContainer.scrollLeft;
          const scrollRight = scrollLeft + containerWidth;

          // Add some padding so needle doesn't stick to edge
          const padding = containerWidth * 0.1; // 10% padding

          // Check if needle is off-screen and auto-scroll
          if (position < scrollLeft + padding) {
            // Needle going off left side
            timelineContainer.scrollLeft = Math.max(0, position - padding);
          } else if (position > scrollRight - padding) {
            // Needle going off right side
            timelineContainer.scrollLeft = position - containerWidth + padding;
          }
        }
      }

      if (mediaOps.isPlaying && mediaElement) {
        animationFrameRef.current = requestAnimationFrame(updateNeedle);
      }
    };

    if (mediaOps.isPlaying && mediaElement) {
      animationFrameRef.current = requestAnimationFrame(updateNeedle);
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [mediaOps.isPlaying, mediaElement, mediaOps.pixelsPerSecond]);

  // The waveform picture: decoded once, redrawn for the stretch on screen.
  const waveform = useWaveform({
    mediaBlob: mediaOps.mediaBlob,
    duration: mediaOps.duration,
    timelineWidth,
    scrollLeft: timelineScrollLeft,
    containerRef: timelineContainerRef,
  });

  return {
    // State
    isDragging,
    tempSelection,
    waveformImage: waveform.image,
    waveformBox: waveform.box,
    isLoadingWaveform: waveform.loading,
    isResizing,
    resizingToken,
    tempTokenBounds,
    timelineScrollLeft,
    timelineWidth,

    // Calculations
    getVisibleTokens,
    getTimeFromPosition,
    autoScrollToTime,

    // Event handlers
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleResizeStart,
    handlePixelsPerSecondChange,
    zoomTo,
    handleTimelineClick,
    handleSelectionCreate,
    handleAlignmentCreated,

    // Refs
    timelineRef,
    needleRef,
    timelineContainerRef,

    // State setters for external use
    setTimelineScrollLeft,

    // Constants
    TIMELINE_HEIGHT,
  };
};
