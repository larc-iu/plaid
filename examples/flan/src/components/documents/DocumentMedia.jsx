import React, { useState, useRef, useEffect } from 'react';
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
  Center, Title
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { TimeAlignmentPopover } from './media/TimeAlignmentPopover.jsx';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconPlayerPause from '@tabler/icons-react/dist/esm/icons/IconPlayerPause.mjs';
import IconPlayerSkipBack from '@tabler/icons-react/dist/esm/icons/IconPlayerSkipBack.mjs';
import IconPlayerSkipForward from '@tabler/icons-react/dist/esm/icons/IconPlayerSkipForward.mjs';
import IconVolume from '@tabler/icons-react/dist/esm/icons/IconVolume.mjs';
import IconZoomIn from '@tabler/icons-react/dist/esm/icons/IconZoomIn.mjs';
import IconZoomOut from '@tabler/icons-react/dist/esm/icons/IconZoomOut.mjs';
import IconUpload from '@tabler/icons-react/dist/esm/icons/IconUpload.mjs';
import IconPlayerTrackPrev from '@tabler/icons-react/dist/esm/icons/IconPlayerTrackPrev.mjs';
import IconPlayerTrackNext from '@tabler/icons-react/dist/esm/icons/IconPlayerTrackNext.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import { notifications } from '@mantine/notifications';

// Constants
const TIMELINE_HEIGHT = 100;
const WAVEFORM_AVAILABLE_HEIGHT = 90;
const MIN_BAR_HEIGHT = 2;
const WAVEFORM_CACHE_PREFIX = 'flan_waveform_';
const WAVEFORM_CACHE_VERSION = 'v1_'; // Increment when waveform generation logic changes

// Utility function for formatting time
const formatTime = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

// Utility functions for waveform caching
const generateAudioHash = async (arrayBuffer) => {
  // Create a simple hash from audio data
  const uint8Array = new Uint8Array(arrayBuffer);
  let hash = 0;
  
  // Sample every nth byte to create a reasonable hash without processing entire file
  const step = Math.max(1, Math.floor(uint8Array.length / 10000));
  for (let i = 0; i < uint8Array.length; i += step) {
    hash = ((hash << 5) - hash + uint8Array[i]) & 0xffffffff;
  }
  
  return hash.toString(36);
};

const getCacheKey = (audioHash, timelineWidth, duration) => {
  return `${WAVEFORM_CACHE_PREFIX}${WAVEFORM_CACHE_VERSION}${audioHash}_${timelineWidth}_${Math.round(duration)}`;
};

const getCachedWaveform = (cacheKey) => {
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      // Check if cache entry is not too old (7 days)
      if (Date.now() - data.timestamp < 7 * 24 * 60 * 60 * 1000) {
        return data.imageData;
      } else {
        localStorage.removeItem(cacheKey);
      }
    }
  } catch (error) {
    console.warn('Failed to read waveform cache:', error);
  }
  return null;
};

const setCachedWaveform = (cacheKey, imageData) => {
  try {
    const data = {
      imageData,
      timestamp: Date.now()
    };
    localStorage.setItem(cacheKey, JSON.stringify(data));
  } catch (error) {
    console.warn('Failed to cache waveform (storage might be full):', error);
    // Try to clear old cache entries and retry
    clearOldWaveformCache();
    try {
      localStorage.setItem(cacheKey, JSON.stringify(data));
    } catch (retryError) {
      console.warn('Failed to cache waveform after cleanup:', retryError);
    }
  }
};

const clearOldWaveformCache = () => {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(WAVEFORM_CACHE_PREFIX)) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          // Remove entries older than 7 days
          if (Date.now() - data.timestamp > 7 * 24 * 60 * 60 * 1000) {
            keysToRemove.push(key);
          }
        } catch (e) {
          // Remove malformed cache entries
          keysToRemove.push(key);
        }
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch (error) {
    console.warn('Failed to clear old waveform cache:', error);
  }
};

// Media Player Component  
const MediaPlayer = ({ mediaUrl, onTimeUpdate, onDurationChange, onPlayingChange, currentTime, volume, onVolumeChange, onSkipToBeginning, onSkipToEnd, onMediaElementReady, mediaElement, isPlaying: parentIsPlaying, onSeek, onDeleteMedia }) => {
  const mediaRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mediaError, setMediaError] = useState(null);
  const animationFrameRef = useRef(null);

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
      mediaRef.current.pause(); // Stop playback when seeking
      mediaRef.current.currentTime = time;
      onTimeUpdate && onTimeUpdate(time); // Update state immediately
      onSeek && onSeek(time); // Notify parent of seek
    }
  };

  const skipTime = (seconds) => {
    if (mediaRef.current) {
      const newTime = Math.max(0, Math.min(duration, mediaRef.current.currentTime + seconds));
      mediaRef.current.pause(); // Stop playback when skipping
      mediaRef.current.currentTime = newTime;
      onTimeUpdate && onTimeUpdate(newTime); // Update state immediately
      onSeek && onSeek(newTime); // Notify parent of seek
    }
  };

  const [mediaType, setMediaType] = useState('video');
  const [isSupported, setIsSupported] = useState(true);

  // RAF-based smooth time updates for progress bar
  useEffect(() => {
    const updateTime = () => {
      if (mediaRef.current && onTimeUpdate) {
        onTimeUpdate(mediaRef.current.currentTime);
      }
      
      if (isPlaying && mediaRef.current) {
        animationFrameRef.current = requestAnimationFrame(updateTime);
      }
    };

    if (isPlaying && mediaRef.current) {
      animationFrameRef.current = requestAnimationFrame(updateTime);
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
  }, [isPlaying, onTimeUpdate]);

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" align="center" mb="1rem">
        <div>
          <Title order={3}>Time Alignment</Title>
        </div>
        {mediaUrl && (
          <Group>
            <Tooltip label="Delete media file">
              <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="md"
                  onClick={onDeleteMedia}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>

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
          onTimeUpdate={() => {}} // RAF handles time updates now
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
            label={(value) => formatTime(value)}
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
const Timeline = ({ duration, currentTime, pixelsPerSecond, onPixelsPerSecondChange, alignmentTokens, onTimelineClick, onSelectionCreate, selection, onPlaySelection, onClearSelection, mediaUrl, mediaElement, isPlaying, onEditSelection, popoverOpened, setPopoverOpened, client, parsedDocument, project, handleAlignmentCreated, timelineContainerRef }) => {
  const timelineRef = useRef(null);
  const needleRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [tempSelection, setTempSelection] = useState(null);
  const [waveformImage, setWaveformImage] = useState(null);
  const [isLoadingWaveform, setIsLoadingWaveform] = useState(false);
  const animationFrameRef = useRef(null);

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
    
    // Only close popover if clicking outside existing selection
    if (!selection || time < selection.start || time > selection.end) {
      setPopoverOpened(false);
    }
    
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

  // Handle wheel events with proper passive listener setup
  useEffect(() => {
    const handleWheel = (event) => {
      event.preventDefault();
      
      if (event.ctrlKey || event.metaKey) {
        // CTRL+scroll: zoom in/out (modify pixels per second)
        const delta = event.deltaY > 0 ? -1 : 1; // Reverse for natural zooming
        const zoomFactor = 1.1;
        const newPixelsPerSecond = delta > 0 
          ? Math.min(100, pixelsPerSecond * zoomFactor)
          : Math.max(4, pixelsPerSecond / zoomFactor);
        onPixelsPerSecondChange && onPixelsPerSecondChange(newPixelsPerSecond);
      } else {
        // Normal scroll: pan left/right
        const scrollAmount = 50; // pixels to scroll
        const container = timelineContainerRef.current;
        if (container) {
          const delta = event.deltaY > 0 ? scrollAmount : -scrollAmount;
          container.scrollLeft += delta;
        }
      }
    };

    const container = timelineContainerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        container.removeEventListener('wheel', handleWheel);
      };
    }
  }, [pixelsPerSecond, onPixelsPerSecondChange]);

  const timelineWidth = duration * pixelsPerSecond;
  
  // Smooth needle movement with auto-scroll
  useEffect(() => {
    const updateNeedle = () => {
      if (needleRef.current && timelineRef.current && mediaElement && pixelsPerSecond > 0) {
        const currentTime = mediaElement.currentTime;
        const position = currentTime * pixelsPerSecond;
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
  
  // Cleanup object URLs to prevent memory leaks
  useEffect(() => {
    return () => {
      if (waveformImage && waveformImage.startsWith('blob:')) {
        URL.revokeObjectURL(waveformImage);
      }
    };
  }, [waveformImage]);

  // Generate canvas-based waveform image
  useEffect(() => {
    const generateWaveformImage = async () => {
      if (!mediaUrl || !duration || waveformImage || timelineWidth < 100) return;
      
      setIsLoadingWaveform(true);
      
      let audioHash = null;
      let cacheKey = null;
      
      try {
        const response = await fetch(mediaUrl);
        const arrayBuffer = await response.arrayBuffer();
        
        // Generate hash from audio data for caching
        audioHash = await generateAudioHash(arrayBuffer);
        cacheKey = getCacheKey(audioHash, timelineWidth, duration);
        
        // Check cache first
        const cachedWaveform = getCachedWaveform(cacheKey);
        if (cachedWaveform) {
          // Cached waveform is a data URL, use it directly
          setWaveformImage(cachedWaveform);
          setIsLoadingWaveform(false);
          return;
        }
        
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        // Get channel data (use first channel)
        const channelData = audioBuffer.getChannelData(0);
        
        // Create high-resolution canvas for waveform
        const pixelRatio = window.devicePixelRatio || 1;
        const canvas = window.document.createElement('canvas');
        
        // Cap canvas width to prevent browser limits (most browsers limit to ~32k pixels)
        const maxCanvasWidth = 16384; // Conservative limit
        const idealCanvasWidth = timelineWidth * pixelRatio;
        const canvasWidth = Math.min(idealCanvasWidth, maxCanvasWidth);
        const canvasHeight = TIMELINE_HEIGHT * pixelRatio;
        
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');
        
        // Scale context for high DPI
        ctx.scale(pixelRatio, pixelRatio);
        
        // Clear canvas
        ctx.fillStyle = 'transparent';
        const effectiveTimelineWidth = canvasWidth / pixelRatio;
        ctx.fillRect(0, 0, effectiveTimelineWidth, TIMELINE_HEIGHT);
        
        // Draw waveform
        ctx.fillStyle = '#90caf9';
        ctx.globalAlpha = 0.8;
        
        // Use much higher sampling rate for better resolution
        const samples = Math.max(effectiveTimelineWidth * 2, 8000);
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
        
        for (let i = 0; i < samples; i++) {
          const amplitude = amplitudes[i];
          // Scale amplitude to use full height, with minimum bar height
          const normalizedAmplitude = maxAmplitude > 0 ? amplitude / maxAmplitude : 0;
          const barHeight = Math.max(MIN_BAR_HEIGHT, normalizedAmplitude * WAVEFORM_AVAILABLE_HEIGHT);
          const y = (TIMELINE_HEIGHT / 2) - barHeight / 2;
          
          const x = (i / samples) * effectiveTimelineWidth;
          const barWidth = effectiveTimelineWidth / samples;
          ctx.fillRect(x, y, Math.max(0.5, barWidth), barHeight);
        }
        
        // Convert canvas to data URL for caching and blob for immediate use
        canvas.toBlob(async (blob) => {
          if (blob) {
            const imageUrl = URL.createObjectURL(blob);
            setWaveformImage(imageUrl);
            
            // Cache the data URL version for persistence
            const dataUrl = canvas.toDataURL('image/png', 0.8);
            setCachedWaveform(cacheKey, dataUrl);
          }
        });
        
      } catch (error) {
        console.error('Failed to generate waveform:', error);
        // Create fallback waveform
        const pixelRatio = window.devicePixelRatio || 1;
        const canvas = window.document.createElement('canvas');
        canvas.width = timelineWidth * pixelRatio;
        canvas.height = TIMELINE_HEIGHT * pixelRatio;
        const ctx = canvas.getContext('2d');
        
        // Scale context for high DPI
        ctx.scale(pixelRatio, pixelRatio);
        
        ctx.fillStyle = '#90caf9';
        ctx.globalAlpha = 0.3;
        
        const effectiveTimelineWidth = timelineWidth;
        const samples = timelineWidth * 2;
        for (let i = 0; i < samples; i++) {
          const height = Math.random() * 40 + 5;
          const x = (i / samples) * effectiveTimelineWidth;
          const barWidth = effectiveTimelineWidth / samples;
          ctx.fillRect(x, (TIMELINE_HEIGHT / 2) - height/2, Math.max(0.5, barWidth), height);
        }
        
        canvas.toBlob((blob) => {
          if (blob) {
            setWaveformImage(URL.createObjectURL(blob));
          }
        });
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
        <Box 
          ref={timelineContainerRef} 
          style={{ overflowX: 'auto', border: '1px solid #e0e0e0', borderRadius: '4px', paddingTop: '50px' }}
        >
          <Box 
            ref={timelineRef}
            style={{ 
              position: 'relative', 
              height: `${TIMELINE_HEIGHT}px`,
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
                client={client}
                parsedDocument={parsedDocument}
                project={project}
                onAlignmentCreated={handleAlignmentCreated}
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
                  <ActionIcon onClick={onPlaySelection} size="sm" variant="filled" color="blue">
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
            {alignmentTokens.map((token, index) => (
              <div
                key={token.id || index}
                onClick={(e) => {
                  e.stopPropagation();
                  // Create selection from alignment token
                  const tokenSelection = {
                    start: token.metadata?.timeBegin || 0,
                    end: token.metadata?.timeEnd || 0
                  };
                  onSelectionCreate(tokenSelection.start, tokenSelection.end);
                }}
                style={{
                  position: 'absolute',
                  left: `${(token.metadata?.timeBegin || 0) * pixelsPerSecond}px`,
                  width: `${((token.metadata?.timeEnd || token.metadata?.timeBegin || 1) - (token.metadata?.timeBegin || 0)) * pixelsPerSecond}px`,
                  top: 0,
                  bottom: 0,
                  backgroundColor: 'rgba(25, 118, 210, 0.15)',
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
                title={`${parsedDocument?.document?.text?.body?.substring(token.begin, token.end) || ''} (${formatTime(token.metadata?.timeBegin || 0)} - ${formatTime(token.metadata?.timeEnd || 0)})`}
              >
                {parsedDocument?.document?.text?.body?.substring(token.begin, token.end) || ''}
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

export const DocumentMedia = ({ parsedDocument, project, client, onMediaUpdated }) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(25);
  const [isUploading, setIsUploading] = useState(false);
  const [selection, setSelection] = useState(null); // { start: number, end: number }
  const [mediaElement, setMediaElement] = useState(null); // EWAN pattern: store element in state
  const [playingSelection, setPlayingSelection] = useState(null); // Track if we're playing a selection
  const [popoverOpened, setPopoverOpened] = useState(false);
  const selectionMonitorRef = useRef(null);
  const timelineContainerRef = useRef(null);

  // Get authenticated media URL with proper base path handling
  const getAuthenticatedMediaUrl = (serverUrl) => {
    if (!serverUrl || !client?.token) return serverUrl;
    return `${serverUrl}?token=${client.token}`;
  };

  const authenticatedMediaUrl = getAuthenticatedMediaUrl(parsedDocument?.document?.mediaUrl);

  // Get alignment token layer
  const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
  const alignmentTokens = parsedDocument?.alignmentTokens || [];

  // Helper function to auto-scroll timeline to show current position
  const autoScrollToTime = (time) => {
    if (timelineContainerRef.current && pixelsPerSecond > 0) {
      const position = time * pixelsPerSecond;
      const containerWidth = timelineContainerRef.current.clientWidth;
      const scrollLeft = position - containerWidth / 2; // Center the position
      timelineContainerRef.current.scrollLeft = Math.max(0, scrollLeft);
    }
  };

  // Handle seek events from media player controls
  const handleSeek = (time) => {
    setPlayingSelection(null); // Clear any playing selection
    autoScrollToTime(time); // Auto-scroll timeline to show seeked position
  };

  const handleMediaUpload = async (file) => {
    if (!file) return;

    try {
      setIsUploading(true);
      await client.documents.uploadMedia(parsedDocument.document.id, file);
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
      mediaElement.pause(); // Stop playback when clicking timeline
      mediaElement.currentTime = time;
      setCurrentTime(time); // Update state immediately
      setPlayingSelection(null);
      
      // If clicking inside existing selection, open popover (if not already open)
      if (selection && time >= selection.start && time <= selection.end && !popoverOpened) {
        setPopoverOpened(true);
      }
    }
  };

  const handleSelectionCreate = (startTime, endTime) => {
    const newSelection = { start: startTime, end: endTime };
    setSelection(newSelection);
    setPopoverOpened(true); // Open popover immediately when selection is created
  };

  const handlePlaySelection = () => {
    if (selection && mediaElement) {
      mediaElement.currentTime = selection.start;
      setPlayingSelection(selection);
      mediaElement.play();
    }
  };

  // Setup hotkeys
  useHotkeys([
    // ESC key to clear selection
    ['Escape', () => {
      if (selection) {
        setSelection(null);
        setPopoverOpened(false);
      }
    }],
    
    // Space key to toggle playback
    ['space', () => {
      if (mediaElement) {
        if (isPlaying) {
          mediaElement.pause();
        } else {
          mediaElement.play();
        }
      }
    }],
    
    // Ctrl+Space to play selection
    ['ctrl+space', () => {
      if (selection && mediaElement) {
        handlePlaySelection();
      }
    }]
  ]);

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

  const handleSkipToBeginning = () => {
    if (mediaElement) {
      mediaElement.pause(); // Stop playback
      mediaElement.currentTime = 0;
      setCurrentTime(0); // Update state immediately
      setPlayingSelection(null);
      autoScrollToTime(0); // Auto-scroll timeline
    }
  };

  const handleSkipToEnd = () => {
    if (mediaElement && duration) {
      mediaElement.pause(); // Stop playback
      mediaElement.currentTime = duration;
      setCurrentTime(duration); // Update state immediately
      setPlayingSelection(null);
      autoScrollToTime(duration); // Auto-scroll timeline
    }
  };

  const handleClearSelection = () => {
    setSelection(null);
    setPopoverOpened(false); // Close popover when selection is cleared
  };

  const handleAlignmentCreated = () => {
    // Clear selection and refresh document
    setSelection(null);
    setPopoverOpened(false);
    if (onMediaUpdated) {
      onMediaUpdated();
    }
  };

  const handleEditSelection = (selection) => {
    setPopoverOpened(true);
  };

  const handleDeleteMedia = async () => {
    if (!parsedDocument?.document?.id || !client) return;

    if (!confirm('Are you sure you want to delete this media file? This action cannot be undone.')) {
      return;
    }

    try {
      await client.documents.deleteMedia(parsedDocument.document.id);
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

  // If no media, show upload interface
  if (!parsedDocument?.document?.mediaUrl) {
    return (
      <Stack spacing="lg">
        <MediaUpload onUpload={handleMediaUpload} isUploading={isUploading} />
      </Stack>
    );
  }

  return (
    <Stack spacing="lg" mb="400px">
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
        onSeek={handleSeek}
        onDeleteMedia={handleDeleteMedia}
      />

      {/* Timeline */}
      <Box style={{ position: 'relative' }}>
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
          onEditSelection={handleEditSelection}
          popoverOpened={popoverOpened}
          setPopoverOpened={setPopoverOpened}
          client={client}
          parsedDocument={parsedDocument}
          project={project}
          handleAlignmentCreated={handleAlignmentCreated}
          timelineContainerRef={timelineContainerRef}
        />
      </Box>

    </Stack>
  );
};