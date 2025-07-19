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
import { notifications } from '@mantine/notifications';

// Media Player Component  
const MediaPlayer = ({ mediaUrl, onTimeUpdate, onDurationChange, onPlayingChange, currentTime, volume, onVolumeChange, onSeekRequest, onSkipToBeginning, onSkipToEnd, onMediaElementReady }) => {
  const mediaRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mediaError, setMediaError] = useState(null);

  // Handle external seek requests (from timeline clicks)
  useEffect(() => {
    if (onSeekRequest && mediaRef.current && Math.abs(mediaRef.current.currentTime - onSeekRequest) > 0.1) {
      mediaRef.current.currentTime = onSeekRequest;
    }
  }, [onSeekRequest]);

  // Expose media element reference to parent
  useEffect(() => {
    if (mediaRef.current && onMediaElementReady) {
      onMediaElementReady(mediaRef.current);
    }
  }, [onMediaElementReady]);

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
      // Manually update parent state when paused
      if (onTimeUpdate) {
        onTimeUpdate(time);
      }
    }
  };

  const skipTime = (seconds) => {
    if (mediaRef.current) {
      const newTime = Math.max(0, Math.min(duration, mediaRef.current.currentTime + seconds));
      mediaRef.current.currentTime = newTime;
      // Manually update parent state when paused
      if (onTimeUpdate) {
        onTimeUpdate(newTime);
      }
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
            borderRadius: '8px'
          }}
          onTimeUpdate={(e) => onTimeUpdate && onTimeUpdate(e.target.currentTime)}
          onDurationChange={(e) => {
            setDuration(e.target.duration);
            onDurationChange && onDurationChange(e.target.duration);
          }}
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
          }}
          onError={(e) => {
            console.error('Media error:', e);
            setMediaError('Failed to load media. This format may not be supported.');
            setIsSupported(false);
          }}
          preload="metadata"
        />

        {/* Transport Controls */}
        <Group justify="center" spacing="xs">
          <Tooltip label="Skip to beginning">
            <ActionIcon onClick={onSkipToBeginning} size="lg">
              <IconPlayerTrackPrev size={20} />
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label="Skip back 5 seconds">
            <ActionIcon onClick={() => skipTime(-5)} size="lg">
              <IconPlayerSkipBack size={20} />
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label={isPlaying ? "Pause" : "Play"}>
            <ActionIcon onClick={togglePlayback} size="xl" variant="filled">
              {isPlaying ? <IconPlayerPause size={24} /> : <IconPlayerPlay size={24} />}
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label="Skip forward 5 seconds">
            <ActionIcon onClick={() => skipTime(5)} size="lg">
              <IconPlayerSkipForward size={20} />
            </ActionIcon>
          </Tooltip>
          
          <Tooltip label="Skip to end">
            <ActionIcon onClick={onSkipToEnd} size="lg">
              <IconPlayerTrackNext size={20} />
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
  
  // Smooth needle movement without React re-renders
  useEffect(() => {
    const updateNeedle = () => {
      if (needleRef.current && mediaElement && pixelsPerSecond > 0) {
        const currentTime = mediaElement.currentTime;
        const position = currentTime * pixelsPerSecond;
        needleRef.current.style.left = `${position}px`;
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
        
        // Create canvas for waveform
        const canvas = document.createElement('canvas');
        canvas.width = timelineWidth;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');
        
        // Clear canvas
        ctx.fillStyle = 'transparent';
        ctx.fillRect(0, 0, timelineWidth, 100);
        
        // Draw waveform
        ctx.fillStyle = '#90caf9';
        ctx.globalAlpha = 0.8;
        
        const samples = timelineWidth;
        const blockSize = Math.floor(channelData.length / samples);
        
        for (let i = 0; i < samples; i++) {
          let sum = 0;
          const start = i * blockSize;
          const end = Math.min(start + blockSize, channelData.length);
          
          for (let j = start; j < end; j++) {
            sum += Math.abs(channelData[j] || 0);
          }
          
          const amplitude = sum / (end - start);
          const barHeight = Math.max(3, amplitude * 90);
          const y = 50 - barHeight / 2;
          
          ctx.fillRect(i, y, 1, barHeight);
        }
        
        // Convert canvas to image
        const imageUrl = canvas.toDataURL();
        setWaveformImage(imageUrl);
        
      } catch (error) {
        console.error('Failed to generate waveform:', error);
        // Create fallback waveform
        const canvas = document.createElement('canvas');
        canvas.width = timelineWidth;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');
        
        ctx.fillStyle = '#90caf9';
        ctx.globalAlpha = 0.3;
        
        for (let i = 0; i < timelineWidth; i += 2) {
          const height = Math.random() * 40 + 5;
          ctx.fillRect(i, 50 - height/2, 1, height);
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
              <ActionIcon onClick={() => onPixelsPerSecondChange(Math.max(25, pixelsPerSecond - 25))} size="sm">
                <IconZoomOut size={16} />
              </ActionIcon>
            </Tooltip>
            <Text size="sm" c="dimmed">{pixelsPerSecond}px/s</Text>
            <Tooltip label="Zoom in">
              <ActionIcon onClick={() => onPixelsPerSecondChange(Math.min(400, pixelsPerSecond + 25))} size="sm">
                <IconZoomIn size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {/* Timeline Visualization */}
        <Box style={{ overflowX: 'auto', border: '1px solid #e0e0e0', borderRadius: '4px', paddingTop: '50px' }}>
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
                  width: '100%',
                  height: '100px',
                  backgroundImage: `url(${waveformImage})`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'cover',
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
            {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => (
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
                {i % 5 === 0 && (
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
            ))}

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

  // Get authenticated media URL with proper base path handling
  const getAuthenticatedMediaUrl = (serverUrl) => {
    if (!serverUrl || !client?.token) return serverUrl;
    
    // If the URL is already absolute (starts with http/https), use it as-is
    if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
      const separator = serverUrl.includes('?') ? '&' : '?';
      return `${serverUrl}${separator}token=${client.token}`;
    }
    
    // For relative URLs with hash routing, get base path by cutting off everything after hash
    const currentOrigin = window.location.origin;
    const currentPathname = window.location.pathname; // Everything before the hash
    
    // Remove leading slash from serverUrl if present to avoid double slashes
    const cleanServerUrl = serverUrl.startsWith('/') ? serverUrl.slice(1) : serverUrl;
    
    // Construct the full URL: origin + pathname + serverUrl
    const fullUrl = `${currentOrigin}${currentPathname}${cleanServerUrl}`;
    
    const separator = fullUrl.includes('?') ? '&' : '?';
    return `${fullUrl}${separator}token=${client.token}`;
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

  const [seekTime, setSeekTime] = useState(null);

  const handleTimelineClick = (time) => {
    setTime(time);
    setSeekTime(time);
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

  // EWAN pattern: direct media element manipulation
  const setTime = (time) => {
    if (mediaElement) {
      const newTime = (time === 'end' && duration) ? duration : time;
      mediaElement.currentTime = newTime;
      // Manually update state when paused (since requestAnimationFrame won't run)
      setCurrentTime(newTime);
    }
  };

  const handlePlaySelection = () => {
    if (selection && mediaElement) {
      setTime(selection.start);
      mediaElement.play();
    }
  };

  const handleSkipToBeginning = () => {
    setTime(0);
  };

  const handleSkipToEnd = () => {
    setTime('end');
  };

  const handleClearSelection = () => {
    setSelection(null);
    notifications.show({
      title: 'Selection Cleared',
      message: 'Time range selection has been cleared',
      color: 'gray'
    });
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
        onSeekRequest={seekTime}
        onSkipToBeginning={handleSkipToBeginning}
        onSkipToEnd={handleSkipToEnd}
        onMediaElementReady={setMediaElement}
      />

      {/* Selection Info */}
      {selection && (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" ta="center">
            Selection: {formatTime(selection.start)} - {formatTime(selection.end)} ({formatTime(selection.end - selection.start)})
          </Text>
        </Paper>
      )}

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

      {/* Instructions */}
      <Alert icon={<IconInfoCircle size={16} />} color="blue">
        Click on the timeline to seek to a specific time. Drag to select time ranges for transcription.
        Use the zoom controls to adjust the timeline scale. Existing alignment tokens are shown as blue bars.
      </Alert>
    </Stack>
  );
};