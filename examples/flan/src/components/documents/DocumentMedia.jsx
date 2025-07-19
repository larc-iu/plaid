import { useState, useRef, useEffect } from 'react';
import { 
  Stack, 
  Text, 
  Paper,
  Button,
  Group,
  Alert,
  Box,
  ActionIcon,
  Tooltip,
  Slider,
  FileButton,
  Center
} from '@mantine/core';
// Using custom waveform implementation due to react-audio-visualize compatibility issues
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconPlayerPause from '@tabler/icons-react/dist/esm/icons/IconPlayerPause.mjs';
import IconPlayerSkipBack from '@tabler/icons-react/dist/esm/icons/IconPlayerSkipBack.mjs';
import IconPlayerSkipForward from '@tabler/icons-react/dist/esm/icons/IconPlayerSkipForward.mjs';
import IconVolume from '@tabler/icons-react/dist/esm/icons/IconVolume.mjs';
import IconZoomIn from '@tabler/icons-react/dist/esm/icons/IconZoomIn.mjs';
import IconZoomOut from '@tabler/icons-react/dist/esm/icons/IconZoomOut.mjs';
import IconUpload from '@tabler/icons-react/dist/esm/icons/IconUpload.mjs';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconPlayerTrackPrev from '@tabler/icons-react/dist/esm/icons/IconPlayerTrackPrev.mjs';
import IconPlayerTrackNext from '@tabler/icons-react/dist/esm/icons/IconPlayerTrackNext.mjs';
import IconClearAll from '@tabler/icons-react/dist/esm/icons/IconClearAll.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import { notifications } from '@mantine/notifications';

// Media Player Component  
const MediaPlayer = ({ mediaUrl, onTimeUpdate, onDurationChange, onPlayingChange, currentTime, volume, onVolumeChange, onSkipToBeginning, onSkipToEnd, onMediaElementReady, mediaElement, isPlaying: parentIsPlaying }) => {
  const mediaRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mediaError, setMediaError] = useState(null);

  // Remove the problematic seek useEffect - we'll use direct manipulation instead

  // Expose media element reference to parent
  useEffect(() => {
    if (mediaRef.current && onMediaElementReady) {
      onMediaElementReady(mediaRef.current);
    }
  }, [onMediaElementReady]);

  // No direct slider manipulation - let React handle it through props

  const togglePlayback = async () => {
    if (mediaRef.current) {
      try {
        if (isPlaying) {
          mediaRef.current.pause();
        } else {
          await mediaRef.current.play();
        }
        setMediaError(null);
      } catch (error) {
        console.error('Media playback error:', error);
        setMediaError('Media format not supported by your browser. Please try MP4, WebM, MP3, or WAV files.');
        setIsPlaying(false);
      }
    }
  };

  const seekTo = (time) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = time;
    }
  };

  const skipTime = (seconds) => {
    if (mediaRef.current) {
      const newTime = Math.max(0, Math.min(duration, mediaRef.current.currentTime + seconds));
      mediaRef.current.currentTime = newTime;
    }
  };

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Since we can't determine type from URL without extension, 
  // we'll use a video element for everything (it can play audio too)
  const [mediaType, setMediaType] = useState('video');
  const [isSupported, setIsSupported] = useState(true); // Assume supported until proven otherwise

  return (
    <Paper withBorder p="md">
      <Stack spacing="md">
        {/* Format warning */}
        {!isSupported && (
          <Alert color="orange" title="Unsupported Media Format">
            This media format may not be supported by your browser. For best results, please use:
            <br />• Video: MP4, WebM, OGV, MOV
            <br />• Audio: MP3, WAV, OGG, M4A, AAC
          </Alert>
        )}

        {/* Media error */}
        {mediaError && (
          <Alert color="red" title="Playback Error">
            {mediaError}
          </Alert>
        )}
        {/* Media Element - Use video element for everything since it can play both video and audio */}
        <video
          ref={mediaRef}
          src={mediaUrl}
          controls={false} // We provide custom controls
          style={{ 
            width: '100%', 
            maxHeight: '400px',
            backgroundColor: '#000',
            borderRadius: '8px',
            display: mediaType === 'audio' ? 'none' : 'block'
          }}
          onTimeUpdate={(e) => onTimeUpdate && onTimeUpdate(e.target.currentTime)}
          onPlay={() => {
            setIsPlaying(true);
            onPlayingChange && onPlayingChange(true);
          }}
          onPause={() => {
            setIsPlaying(false);
            onPlayingChange && onPlayingChange(false);
          }}
          onLoadedMetadata={(e) => {
            setDuration(e.target.duration);
            onDurationChange && onDurationChange(e.target.duration);

            // Detect if this is actually a video or just audio
            const video = e.target;
            if (video.videoWidth === 0 || video.videoHeight === 0) {
              setMediaType('audio');
            } else {
              setMediaType('video');
            }

            // Ensure parent gets the media element reference
            if (onMediaElementReady) {
              onMediaElementReady(e.target);
            }
          }}
          onError={(e) => {
            console.error('Media error:', e);
            setMediaError('Failed to load media. This format may not be supported.');
            setIsSupported(false);
          }}
          preload="auto"
        />

        {/* Transport Controls */}
        <Group justify="center" spacing="xs">
          <Tooltip label="Skip to beginning">
            <ActionIcon onClick={onSkipToBeginning} size="lg">
              <IconPlayerSkipBack size={20} />
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label="Skip back 5 seconds">
            <ActionIcon onClick={() => skipTime(-5)} size="lg">
              <IconPlayerTrackPrev size={20} />
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label={isPlaying ? "Pause" : "Play"}>
            <ActionIcon onClick={togglePlayback} size="xl" variant="filled">
              {isPlaying ? <IconPlayerPause size={24} /> : <IconPlayerPlay size={24} />}
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label="Skip forward 5 seconds">
            <ActionIcon onClick={() => skipTime(5)} size="lg">
              <IconPlayerTrackNext size={20} />
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label="Skip to end">
            <ActionIcon onClick={onSkipToEnd} size="lg">
              <IconPlayerSkipForward size={20} />
            </ActionIcon>
          </Tooltip>
        </Group>

        {/* Time Display and Seek Bar */}
        <Stack spacing="xs">
          <Group justify="space-between" spacing="xs">
            <Text size="sm" c="dimmed">{formatTime(currentTime || 0)}</Text>
            <Text size="sm" c="dimmed">{formatTime(duration || 0)}</Text>
          </Group>
          
          <Slider
            value={currentTime || 0}
            max={duration || 100}
            onChange={seekTo}
            size="sm"
            style={{ flex: 1 }}
          />
        </Stack>

        {/* Volume Control */}
        <Group spacing="xs">
          <IconVolume size={16} />
          <Slider
            value={volume}
            onChange={onVolumeChange}
            min={0}
            max={1}
            step={0.1}
            style={{ flex: 1, maxWidth: 150 }}
            size="sm"
          />
        </Group>
      </Stack>
    </Paper>
  );
};

// Timeline Component  
const Timeline = ({ duration, currentTime, pixelsPerSecond, onPixelsPerSecondChange, alignmentTokens, onTimelineClick, onSelectionCreate, selection, onPlaySelection, onClearSelection, mediaUrl, mediaElement, isPlaying }) => {
  const timelineRef = useRef(null);
  const containerRef = useRef(null);
  const needleRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [tempSelection, setTempSelection] = useState(null);
  const [waveformImage, setWaveformImage] = useState(null);
  const [isLoadingWaveform, setIsLoadingWaveform] = useState(false);
  const animationFrameRef = useRef(null);

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const getTimeFromPosition = (clientX) => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const timeAtClick = clickX / pixelsPerSecond;
    return Math.max(0, Math.min(duration, timeAtClick));
  };

  const handleMouseDown = (event) => {
    if (event.button !== 0) return; // Only left mouse button
    
    const time = getTimeFromPosition(event.clientX);
    setIsDragging(true);
    setDragStart(time);
    setDragEnd(time);
    setTempSelection(null);
  };

  const handleMouseMove = (event) => {
    if (!isDragging) return;
    
    const time = getTimeFromPosition(event.clientX);
    setDragEnd(time);
    
    // Create temporary selection for visual feedback
    const start = Math.min(dragStart, time);
    const end = Math.max(dragStart, time);
    setTempSelection({ start, end });
  };

  const handleMouseUp = (event) => {
    if (!isDragging) return;
    
    const time = getTimeFromPosition(event.clientX);
    const start = Math.min(dragStart, time);
    const end = Math.max(dragStart, time);
    
    setIsDragging(false);
    setTempSelection(null);
    
    // If it's just a click (very small selection), seek to that time
    if (Math.abs(end - start) < 0.1) {
      onTimelineClick && onTimelineClick(start);
    } else {
      // If it's a proper selection, create a time range for annotation
      onSelectionCreate && onSelectionCreate(start, end);
    }
    
    setDragStart(null);
    setDragEnd(null);
  };

  const handleTimelineClick = (event) => {
    // This is handled by mouseUp, but keeping for compatibility
    if (!isDragging) {
      const time = getTimeFromPosition(event.clientX);
      onTimelineClick && onTimelineClick(time);
    }
  };

  const timelineWidth = duration * pixelsPerSecond;
  
  // Smooth needle movement with auto-scroll
  useEffect(() => {
    const updateNeedle = () => {
      if (needleRef.current && timelineRef.current && mediaElement && pixelsPerSecond > 0) {
        const currentTime = mediaElement.currentTime;
        const position = currentTime * pixelsPerSecond;
        needleRef.current.style.left = `${position}px`;
        
        // Auto-scroll to keep needle in view
        const timelineContainer = containerRef.current; // The scrollable Box
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
      
      if (isPlaying && mediaElement) {
        animationFrameRef.current = requestAnimationFrame(updateNeedle);
      }
    };

    if (isPlaying && mediaElement) {
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
  }, [isPlaying, mediaElement, pixelsPerSecond]);
  
  // Generate canvas-based waveform image
  useEffect(() => {
    const generateWaveformImage = async () => {
      if (!mediaUrl || !duration || waveformImage || timelineWidth < 100) return;
      
      setIsLoadingWaveform(true);
      try {
        const response = await fetch(mediaUrl);
        const arrayBuffer = await response.arrayBuffer();
        
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        // Get channel data (use first channel)
        const channelData = audioBuffer.getChannelData(0);
        
        // Create high-resolution canvas for waveform
        const pixelRatio = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        const canvasWidth = timelineWidth * pixelRatio;
        const canvasHeight = 100 * pixelRatio;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');
        
        // Scale context for high DPI
        ctx.scale(pixelRatio, pixelRatio);
        
        // Clear canvas
        ctx.fillStyle = 'transparent';
        ctx.fillRect(0, 0, timelineWidth, 100);
        
        // Draw waveform
        ctx.fillStyle = '#90caf9';
        ctx.globalAlpha = 0.8;
        
        // Use much higher sampling rate for better resolution
        const samples = Math.max(timelineWidth * 2, 4000); // At least 2x timeline width or 4000 samples
        const blockSize = Math.floor(channelData.length / samples);
        
        // First pass: calculate all amplitudes and find the maximum
        const amplitudes = [];
        let maxAmplitude = 0;
        
        for (let i = 0; i < samples; i++) {
          let sum = 0;
          const start = i * blockSize;
          const end = Math.min(start + blockSize, channelData.length);
          
          for (let j = start; j < end; j++) {
            sum += Math.abs(channelData[j] || 0);
          }
          
          const amplitude = sum / (end - start);
          amplitudes.push(amplitude);
          maxAmplitude = Math.max(maxAmplitude, amplitude);
        }
        
        // Second pass: draw bars scaled to fill available height
        const availableHeight = 90; // Leave 5px padding top/bottom
        const minBarHeight = 2;
        
        for (let i = 0; i < samples; i++) {
          const amplitude = amplitudes[i];
          // Scale amplitude to use full height, with minimum bar height
          const normalizedAmplitude = maxAmplitude > 0 ? amplitude / maxAmplitude : 0;
          const barHeight = Math.max(minBarHeight, normalizedAmplitude * availableHeight);
          const y = 50 - barHeight / 2;
          
          const x = (i / samples) * timelineWidth;
          const barWidth = timelineWidth / samples;
          ctx.fillRect(x, y, Math.max(0.5, barWidth), barHeight);
        }
        
        // Convert canvas to image
        const imageUrl = canvas.toDataURL();
        setWaveformImage(imageUrl);
        
      } catch (error) {
        console.error('Failed to generate waveform:', error);
        // Create fallback waveform
        const pixelRatio = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = timelineWidth * pixelRatio;
        canvas.height = 100 * pixelRatio;
        const ctx = canvas.getContext('2d');
        
        // Scale context for high DPI
        ctx.scale(pixelRatio, pixelRatio);
        
        ctx.fillStyle = '#90caf9';
        ctx.globalAlpha = 0.3;
        
        const samples = timelineWidth * 2;
        for (let i = 0; i < samples; i++) {
          const height = Math.random() * 40 + 5;
          const x = (i / samples) * timelineWidth;
          const barWidth = timelineWidth / samples;
          ctx.fillRect(x, 50 - height/2, Math.max(0.5, barWidth), height);
        }
        
        setWaveformImage(canvas.toDataURL());
      } finally {
        setIsLoadingWaveform(false);
      }
    };

    if (duration > 0 && timelineWidth > 0) {
      generateWaveformImage();
    }
  }, [mediaUrl, duration, timelineWidth]);

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
        <Box ref={containerRef} style={{ overflowX: 'auto', border: '1px solid #e0e0e0', borderRadius: '4px', paddingTop: '50px' }}>
          <Box 
            ref={timelineRef}
            style={{ 
              position: 'relative', 
              height: '100px',
              width: `${timelineWidth}px`,
              minWidth: '100%',
              cursor: isDragging ? 'grabbing' : 'pointer',
              backgroundColor: '#f8f9fa',
              userSelect: 'none'
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
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
                  height: '100px',
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
            {/* Time markers */}
            {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => {
              // If px/s is less than 7, only show 5-second marks and timestamps divisible by 30
              const showSecondTicks = pixelsPerSecond >= 7;
              const showThisTick = showSecondTicks || i % 5 === 0;
              const showTimestamp = i % 5 === 0 && (pixelsPerSecond >= 7 || i % 30 === 0);
              
              return showThisTick ? (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${i * pixelsPerSecond}px`,
                    top: 0,
                    bottom: 0,
                    borderLeft: i % 5 === 0 ? '2px solid #666' : '1px solid #ccc',
                    pointerEvents: 'none'
                  }}
                >
                  {showTimestamp && (
                    <Text
                      size="xs"
                      style={{
                        position: 'absolute',
                        top: '2px',
                        left: '4px',
                        color: '#666',
                        userSelect: 'none'
                      }}
                    >
                      {formatTime(i)}
                    </Text>
                  )}
                </div>
              ) : null;
            })}

            {/* Persistent selection highlight */}
            {selection && (
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
              />
            )}

            {/* Floating play selection button */}
            {selection && (
              <div
                style={{
                  position: 'absolute',
                  left: `${(selection.start + (selection.end - selection.start) / 2) * pixelsPerSecond - 20}px`,
                  top: '-40px',
                  zIndex: 15,
                  pointerEvents: 'auto'
                }}
              >
                <Group spacing="xs">
                  <Tooltip label="Play selected region">
                    <ActionIcon onClick={onPlaySelection} size="sm" variant="filled" color="blue">
                      <IconPlayerPlay size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Clear selection">
                    <ActionIcon onClick={onClearSelection} size="sm" color="red" variant="filled">
                      <IconClearAll size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
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
                width: '2px',
                backgroundColor: '#228be6',
                pointerEvents: 'none',
                zIndex: 10
              }}
            />

            {/* Alignment tokens */}
            {alignmentTokens.map((token, index) => (
              <div
                key={token.id || index}
                style={{
                  position: 'absolute',
                  left: `${(token.timeBegin || 0) * pixelsPerSecond}px`,
                  width: `${((token.timeEnd || token.timeBegin || 1) - (token.timeBegin || 0)) * pixelsPerSecond}px`,
                  top: '60px',
                  height: '30px',
                  backgroundColor: '#e3f2fd',
                  border: '1px solid #1976d2',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 4px',
                  fontSize: '12px',
                  overflow: 'hidden',
                  cursor: 'pointer'
                }}
                title={`${token.text} (${formatTime(token.timeBegin || 0)} - ${formatTime(token.timeEnd || 0)})`}
              >
                {token.text}
              </div>
            ))}
          </Box>
        </Box>
      </Stack>
    </Paper>
  );
};

// Media Upload Component
const MediaUpload = ({ onUpload, isUploading }) => {
  return (
    <Paper withBorder p="xl">
      <Center>
        <Stack align="center" spacing="lg">
          <IconUpload size={48} color="#868e96" />
          <div style={{ textAlign: 'center' }}>
            <Text size="lg" fw={500} mb="xs">Upload Media File</Text>
            <Text size="sm" c="dimmed" mb="md">
              Upload an audio or video file to begin time-aligned transcription
            </Text>
          </div>
          
          <FileButton onChange={onUpload} accept="audio/*,video/*">
            {(props) => (
              <Button 
                {...props} 
                leftSection={<IconUpload size={16} />}
                loading={isUploading}
                size="lg"
              >
                Choose Media File
              </Button>
            )}
          </FileButton>
          
          <Text size="xs" c="dimmed">
            Recommended formats: MP4, WebM, OGG, MOV (video) • MP3, WAV, M4A, AAC (audio)
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
};

export const DocumentMedia = ({ document, parsedDocument, project, client, onMediaUpdated }) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(25);
  const [isUploading, setIsUploading] = useState(false);
  const [selection, setSelection] = useState(null); // { start: number, end: number }
  const [mediaElement, setMediaElement] = useState(null); // EWAN pattern: store element in state
  const [playingSelection, setPlayingSelection] = useState(null); // Track if we're playing a selection
  const selectionMonitorRef = useRef(null);

  // Get authenticated media URL with proper base path handling
  const getAuthenticatedMediaUrl = (serverUrl) => {
    if (!serverUrl || !client?.token) return serverUrl;
    return `${serverUrl}?token=${client.token}`;
  };

  const authenticatedMediaUrl = getAuthenticatedMediaUrl(document?.mediaUrl);

  // Get alignment token layer
  const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
  const alignmentTokens = parsedDocument?.alignmentTokens || [];

  const handleMediaUpload = async (file) => {
    if (!file) return;

    // Check file format
    const fileName = file.name.toLowerCase();
    const supportedFormats = ['mp4', 'webm', 'ogg', 'mov', 'mp3', 'wav', 'm4a', 'aac'];
    const fileExtension = fileName.split('.').pop();
    
    if (!supportedFormats.includes(fileExtension)) {
      notifications.show({
        title: 'Unsupported Format',
        message: `${fileExtension.toUpperCase()} files may not be supported. Please use: MP4, WebM, OGG, MOV, MP3, WAV, M4A, or AAC files for best compatibility.`,
        color: 'orange',
        autoClose: 8000
      });
      // Still allow upload, but warn user
    }
    
    try {
      setIsUploading(true);
      await client.documents.uploadMedia(document.id, file);
      
      notifications.show({
        title: 'Success',
        message: 'Media file uploaded successfully',
        color: 'green'
      });
      
      if (onMediaUpdated) {
        onMediaUpdated();
      }
    } catch (error) {
      console.error('Failed to upload media:', error);
      notifications.show({
        title: 'Upload Failed',
        message: error.message || 'Failed to upload media file',
        color: 'red'
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleTimelineClick = (time) => {
    if (mediaElement) {
      mediaElement.currentTime = time;
      setPlayingSelection(null);
    }
  };

  const handleSelectionCreate = (startTime, endTime) => {
    const newSelection = { start: startTime, end: endTime };
    setSelection(newSelection);
    notifications.show({
      title: 'Time Range Selected',
      message: `Selected ${formatTime(startTime)} - ${formatTime(endTime)}`,
      color: 'blue'
    });
  };


  // Monitor selection playback and auto-pause at end
  useEffect(() => {
    const monitorSelection = () => {
      if (playingSelection && mediaElement && isPlaying) {
        const currentTime = mediaElement.currentTime;
        if (currentTime >= playingSelection.end) {
          // Reached end of selection, snap to exact end and pause
          mediaElement.currentTime = playingSelection.end;
          mediaElement.pause();
          setPlayingSelection(null);
          return; // Stop monitoring
        }
      }
      
      if (playingSelection && isPlaying) {
        selectionMonitorRef.current = requestAnimationFrame(monitorSelection);
      }
    };

    if (playingSelection && isPlaying) {
      selectionMonitorRef.current = requestAnimationFrame(monitorSelection);
    } else {
      if (selectionMonitorRef.current) {
        cancelAnimationFrame(selectionMonitorRef.current);
        selectionMonitorRef.current = null;
      }
    }

    return () => {
      if (selectionMonitorRef.current) {
        cancelAnimationFrame(selectionMonitorRef.current);
        selectionMonitorRef.current = null;
      }
    };
  }, [playingSelection, isPlaying, mediaElement]);

  const handlePlaySelection = () => {
    if (selection && mediaElement) {
      mediaElement.currentTime = selection.start;
      setPlayingSelection(selection);
      mediaElement.play();
    }
  };

  const handleSkipToBeginning = () => {
    if (mediaElement) {
      mediaElement.currentTime = 0;
      setPlayingSelection(null);
    }
  };

  const handleSkipToEnd = () => {
    if (mediaElement && duration) {
      mediaElement.currentTime = duration;
      setPlayingSelection(null);
    }
  };

  const handleClearSelection = () => {
    setSelection(null);
    notifications.show({
      title: 'Selection Cleared',
      message: 'Time range selection has been cleared',
      color: 'gray'
    });
  };

  const handleDeleteMedia = async () => {
    if (!document?.id || !client) return;
    
    if (!confirm('Are you sure you want to delete this media file? This action cannot be undone.')) {
      return;
    }

    try {
      await client.documents.deleteMedia(document.id);
      notifications.show({
        title: 'Media Deleted',
        message: 'Media file has been deleted successfully',
        color: 'green'
      });
      
      if (onMediaUpdated) {
        onMediaUpdated();
      }
    } catch (error) {
      console.error('Failed to delete media:', error);
      notifications.show({
        title: 'Delete Failed',
        message: error.message || 'Failed to delete media file',
        color: 'red'
      });
    }
  };

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // If no media, show upload interface
  if (!document?.mediaUrl) {
    return (
      <Stack spacing="lg">
        <MediaUpload onUpload={handleMediaUpload} isUploading={isUploading} />
      </Stack>
    );
  }

  return (
    <Stack spacing="lg">
      {/* Media Player */}
      <MediaPlayer
        mediaUrl={authenticatedMediaUrl}
        currentTime={currentTime}
        volume={volume}
        onTimeUpdate={setCurrentTime}
        onDurationChange={setDuration}
        onPlayingChange={setIsPlaying}
        onVolumeChange={setVolume}
        onSkipToBeginning={handleSkipToBeginning}
        onSkipToEnd={handleSkipToEnd}
        onMediaElementReady={setMediaElement}
        mediaElement={mediaElement}
        isPlaying={isPlaying}
      />

      {/* Timeline */}
      <Timeline
        duration={duration}
        currentTime={currentTime}
        pixelsPerSecond={pixelsPerSecond}
        onPixelsPerSecondChange={setPixelsPerSecond}
        alignmentTokens={alignmentTokens}
        onTimelineClick={handleTimelineClick}
        onSelectionCreate={handleSelectionCreate}
        selection={selection}
        onPlaySelection={handlePlaySelection}
        onClearSelection={handleClearSelection}
        mediaUrl={authenticatedMediaUrl}
        mediaElement={mediaElement}
        isPlaying={isPlaying}
      />

      {/* Danger Zone */}
      {document?.mediaUrl && (
        <Paper withBorder p="md" style={{ borderColor: '#ccc' }}>
          <Group justify="space-between" align="center">
            <div>
              <Text fw={500} c="gray">Delete Media</Text>
              <Text size="sm" c="dimmed">
                Permanently delete the media file from this document. This action cannot be undone.
              </Text>
            </div>
            <Button
              variant="outline"
              color="gray"
              leftSection={<IconTrash size={16} />}
              onClick={handleDeleteMedia}
            >
              Delete Media
            </Button>
          </Group>
        </Paper>
      )}
    </Stack>
  );
};