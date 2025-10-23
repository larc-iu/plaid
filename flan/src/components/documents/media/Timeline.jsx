import React from 'react';
import {
  Stack,
  Text,
  Paper,
  Group,
  Box,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import IconZoomIn from '@tabler/icons-react/dist/esm/icons/IconZoomIn.mjs';
import IconZoomOut from '@tabler/icons-react/dist/esm/icons/IconZoomOut.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import { useTimelineOperations } from './useTimelineOperations.js';
import { TimeAlignmentPopover } from './TimeAlignmentPopover.jsx';

// Utility function for formatting time
const formatTime = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

export const Timeline = ({ 
  projectId,
  documentId,
  reload,
  client,
  mediaOps,
  readOnly = false
}) => {
  // Destructure what we need from mediaOps
  const {
    mediaElementRef,
    duration,
    currentTime,
    alignmentTokens,
    selection,
    handlePlaySelection: onPlaySelection,
    popoverOpened,
    setPopoverOpened,
    parsedDocument,
    project
  } = mediaOps;
  
  // Use timeline operations hook directly
  const timelineOps = useTimelineOperations(projectId, documentId, reload, client, mediaElementRef.current);
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
    TIMELINE_HEIGHT
  } = timelineOps;
  
  const pixelsPerSecond = parsedDocument.ui.media.pixelsPerSecond;
  
  const onPixelsPerSecondChange = handlePixelsPerSecondChange;
  
  // Register autoScrollToTime with mediaOps
  React.useEffect(() => {
    if (mediaOps.setAutoScrollToTime) {
      mediaOps.setAutoScrollToTime(autoScrollToTime);
    }
  }, [mediaOps, autoScrollToTime]);
  
  return (
    <Paper withBorder p="md">
      <Stack spacing="md">
        {/* Timeline Controls */}
        <Group justify="space-between">
          <Text fw={500}>Timeline</Text>
          <Group spacing="xs">
            <Tooltip label="Zoom out">
              <ActionIcon 
                onClick={() => {
                  // Zoom out by 1/3, minimum 4px/s
                  const newZoom = Math.max(4, pixelsPerSecond / (4/3));
                  onPixelsPerSecondChange(newZoom);
                }} 
                size="sm"
                disabled={pixelsPerSecond <= 4}
              >
                <IconZoomOut size={16} />
              </ActionIcon>
            </Tooltip>
            <Text size="sm" c="dimmed">{Math.round(pixelsPerSecond)}px/s</Text>
            <Tooltip label="Zoom in">
              <ActionIcon 
                onClick={() => {
                  // Zoom in by 1/3, max 100px/s
                  const newZoom = Math.min(100, pixelsPerSecond * (4/3));
                  onPixelsPerSecondChange(newZoom);
                }} 
                size="sm"
                disabled={pixelsPerSecond >= 100}
              >
                <IconZoomIn size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {/* Timeline Visualization */}
        <Box 
          ref={timelineContainerRef} 
          style={{ overflowX: 'auto', border: '1px solid #e0e0e0', borderRadius: '4px', paddingTop: '50px' }}
          onScroll={(e) => setTimelineScrollLeft(e.target.scrollLeft)}
        >
          <Box 
            ref={timelineRef}
            style={{ 
              position: 'relative', 
              height: `${TIMELINE_HEIGHT}px`,
              width: `${timelineWidth}px`,
              minWidth: '100%',
              cursor: readOnly ? 'default' : (isDragging ? 'grabbing' : 'pointer'),
              backgroundColor: '#f8f9fa',
              userSelect: 'none'
            }}
            onMouseDown={readOnly ? undefined : handleMouseDown}
            onMouseMove={readOnly ? undefined : handleMouseMove}
            onMouseUp={readOnly ? undefined : handleMouseUp}
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
                  zIndex: 1
                }}
              />
            )}
            
            {/* Loading indicator for waveform */}
            {isLoadingWaveform && (
              <div style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                color: '#666',
                fontSize: '12px',
                pointerEvents: 'none'
              }}>
                Loading waveform...
              </div>
            )}

            {/* Persistent selection highlight */}
            {selection && (
              <TimeAlignmentPopover
                opened={popoverOpened}
                onClose={() => setPopoverOpened(false)}
                selection={selection}
                parsedDocument={parsedDocument}
                project={project}
                projectId={projectId}
                documentId={documentId}
                onAlignmentCreated={handleAlignmentCreated}
                client={client}
                readOnly={readOnly}
                selectionBox={
                  <div
                    style={{
                      position: 'absolute',
                      left: `${selection.start * pixelsPerSecond}px`,
                      width: `${(selection.end - selection.start) * pixelsPerSecond}px`,
                      top: 0,
                      bottom: 0,
                      backgroundColor: 'rgba(34, 139, 230, 0.15)',
                      border: '2px solid #228be6',
                      pointerEvents: 'none',
                      zIndex: 4
                    }}
                  >
                  </div>
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
                  zIndex: 15
                }}
              >
                <Text
                  size="xs"
                  style={{
                    color: '#228be6',
                    fontWeight: 600
                  }}
                >
                  {formatTime(selection.start)}
                </Text>
                
                <Tooltip label="Play selected region">
                  <ActionIcon 
                    onClick={onPlaySelection} 
                    size="sm" 
                    variant="filled" 
                    color="blue"
                  >
                    <IconPlayerPlay size={12} />
                  </ActionIcon>
                </Tooltip>
                
                <Text
                  size="xs"
                  style={{
                    color: '#228be6',
                    fontWeight: 600
                  }}
                >
                  {formatTime(selection.end)}
                </Text>
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
                  backgroundColor: 'rgba(34, 139, 230, 0.2)',
                  border: '1px solid #228be6',
                  pointerEvents: 'none',
                  zIndex: 5
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
                backgroundColor: '#c40000',
                pointerEvents: 'none',
                zIndex: 10
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
              
              return (
                <div
                  key={token.id || index}
                  style={{
                    position: 'absolute',
                    left: `${displayStart * pixelsPerSecond}px`,
                    width: `${displayWidth}px`,
                    top: 0,
                    bottom: 0,
                    backgroundColor: isBeingResized ? 'rgba(25, 118, 210, 0.25)' : 'rgba(25, 118, 210, 0.15)',
                    border: '1px solid #1976d2',
                    borderRadius: '0px',
                    padding: '4px 4px',
                    lineHeight: '14px',
                    fontSize: '12px',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    color: '#000',
                    fontWeight: 500,
                    zIndex: 3
                  }}
                  onClick={(e) => {
                    if (isResizing) return;
                    e.stopPropagation();
                    // Create selection from alignment token
                    handleSelectionCreate(displayStart, displayEnd);
                  }}
                  title={`${parsedDocument.document.text.body.substring(token.begin, token.end) || ''} (${formatTime(displayStart)} - ${formatTime(displayEnd)})`}
                >
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
                        backgroundColor: '#1976d2',
                        cursor: 'ew-resize',
                        zIndex: 5,
                        opacity: tokenWidth > 20 ? 1 : 0 // Hide on very small tokens
                      }}
                    />
                  )}
                  
                  {/* Token content */}
                  <div style={{ 
                    height: '100%', 
                    display: 'flex', 
                    alignItems: 'center',
                    paddingLeft: tokenWidth > 20 ? '6px' : '2px',
                    paddingRight: tokenWidth > 20 ? '6px' : '2px'
                  }}>
                    {parsedDocument.document.text.body.substring(token.begin, token.end) || ''}
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
                        backgroundColor: '#1976d2',
                        cursor: 'ew-resize',
                        zIndex: 5,
                        opacity: tokenWidth > 20 ? 1 : 0 // Hide on very small tokens
                      }}
                    />
                  )}
                </div>
              );
            })}
          </Box>
        </Box>
      </Stack>
    </Paper>
  );
};