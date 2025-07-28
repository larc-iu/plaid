import { useState, useRef, useEffect, useCallback } from 'react';
import { useSnapshot } from 'valtio';
import { notifications } from '@mantine/notifications';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import documentsStore from '../../../stores/documentsStore.js';

// Constants
const TIMELINE_HEIGHT = 100;
const WAVEFORM_AVAILABLE_HEIGHT = 90;
const MIN_BAR_HEIGHT = 2;
const WAVEFORM_CACHE_PREFIX = 'plaid_waveform_';
const WAVEFORM_CACHE_VERSION = 'v1_'; // Increment when waveform generation logic changes

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

export const useTimelineOperations = (projectId, documentId, reload, client, mediaElement) => {
  const handleError = useStrictModeErrorHandler(reload);
  
  // Get the document snapshot and proxy
  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.media;
  const uiSnap = docSnap.ui.media;
  
  const parsedDocument = docSnap;
  
  // Get authenticated media URL with proper token
  const getAuthenticatedMediaUrl = useCallback((serverUrl) => {
    if (!serverUrl) return serverUrl;
    return `${serverUrl}?token=${localStorage.getItem('token')}`;
  }, []);
  
  // Local timeline state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [tempSelection, setTempSelection] = useState(null);
  const [waveformImage, setWaveformImage] = useState(null);
  const [isLoadingWaveform, setIsLoadingWaveform] = useState(false);
  
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

  // Zoom and timeline calculations
  const timelineWidth = uiSnap.duration * uiSnap.pixelsPerSecond;

  const handlePixelsPerSecondChange = useCallback((newPixelsPerSecond) => {
    uiProxy.pixelsPerSecond = newPixelsPerSecond;
  }, [uiProxy]);

  // Calculate visible tokens for virtualization
  const getVisibleTokens = useCallback(() => {
    if (!timelineContainerRef.current || !uiSnap.duration || uiSnap.pixelsPerSecond <= 0) {
      return docSnap.alignmentTokens || [];
    }

    const containerWidth = timelineContainerRef.current.clientWidth;
    const scrollLeft = timelineScrollLeft;
    
    // Calculate visible time range with buffer
    const bufferTime = 10; // seconds of buffer on each side
    const visibleTimeStart = Math.max(0, scrollLeft / uiSnap.pixelsPerSecond - bufferTime);
    const visibleTimeEnd = Math.min(uiSnap.duration, (scrollLeft + containerWidth) / uiSnap.pixelsPerSecond + bufferTime);
    
    // Filter tokens that intersect with visible range
    return (docSnap.alignmentTokens || []).filter(token => {
      const tokenStart = token.metadata?.timeBegin || 0;
      const tokenEnd = token.metadata?.timeEnd || token.metadata?.timeBegin || 1;
      
      // Check if token intersects with visible range
      return tokenEnd >= visibleTimeStart && tokenStart <= visibleTimeEnd;
    });
  }, [timelineContainerRef, uiSnap.duration, uiSnap.pixelsPerSecond, timelineScrollLeft, docSnap.alignmentTokens]);

  const getTimeFromPosition = useCallback((clientX) => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const timeAtClick = clickX / uiSnap.pixelsPerSecond;
    return Math.max(0, Math.min(uiSnap.duration, timeAtClick));
  }, [uiSnap.pixelsPerSecond, uiSnap.duration]);

  // Helper function to auto-scroll timeline to show current position
  const autoScrollToTime = useCallback((time) => {
    if (timelineContainerRef.current && uiSnap.pixelsPerSecond > 0) {
      const position = time * uiSnap.pixelsPerSecond;
      const containerWidth = timelineContainerRef.current.clientWidth;
      const scrollLeft = position - containerWidth / 2; // Center the position
      timelineContainerRef.current.scrollLeft = Math.max(0, scrollLeft);
    }
  }, [uiSnap.pixelsPerSecond]);

  // Timeline interaction handlers
  const handleTimelineClick = useCallback((time) => {
    if (mediaElement) {
      mediaElement.pause(); // Stop playback when clicking timeline
      mediaElement.currentTime = time;
      uiProxy.currentTime = time; // Update state immediately
      uiProxy.playingSelection = null;
      
      // If clicking inside existing selection, open popover (if not already open)
      if (uiSnap.selection && time >= uiSnap.selection.start && time <= uiSnap.selection.end && !uiSnap.popoverOpened) {
        uiProxy.popoverOpened = true;
      }
    }
  }, [mediaElement, uiProxy, uiSnap.selection, uiSnap.popoverOpened]);

  const handleSelectionCreate = useCallback((startTime, endTime) => {
    const newSelection = { start: startTime, end: endTime };
    uiProxy.selection = newSelection;
    uiProxy.popoverOpened = true; // Open popover immediately when selection is created
  }, [uiProxy]);

  const handleAlignmentCreated = useCallback(async () => {
    // Clear selection and trigger reload since we removed optimistic updates
    uiProxy.selection = null;
    uiProxy.popoverOpened = false;
    
    // Reload to get updated document state
    if (reload) {
      await reload();
    }
  }, [uiProxy, reload]);

  // Mouse event handlers for timeline
  const handleMouseDown = useCallback((event) => {
    if (event.button !== 0) return; // Only left mouse button
    if (isResizing) return; // Don't start new drag while resizing
    
    const time = getTimeFromPosition(event.clientX);
    
    // Only close popover if clicking outside existing selection
    if (!uiSnap.selection || time < uiSnap.selection.start || time > uiSnap.selection.end) {
      uiProxy.popoverOpened = false;
    }
    
    setIsDragging(true);
    setDragStart(time);
    setDragEnd(time);
    setTempSelection(null);
  }, [isResizing, getTimeFromPosition, uiSnap.selection, uiProxy]);

  // Resize event handlers (defined first to avoid reference issues)
  const handleResizeStart = useCallback((event, token, handle) => {
    event.stopPropagation();
    event.preventDefault();
    
    setIsResizing(true);
    setResizingToken(token);
    setResizingHandle(handle);
    setTempTokenBounds({
      start: token.metadata?.timeBegin || 0,
      end: token.metadata?.timeEnd || 0
    });
  }, []);

  const handleResizeMove = useCallback((event) => {
    if (!isResizing || !resizingToken) return;
    
    const currentTime = getTimeFromPosition(event.clientX);
    
    setTempTokenBounds(prevBounds => {
      if (!prevBounds) return prevBounds;
      
      let newStart = prevBounds.start;
      let newEnd = prevBounds.end;
      
      if (resizingHandle === 'left') {
        newStart = Math.max(0, Math.min(currentTime, prevBounds.end - 0.1)); // Min 0.1s width
      } else if (resizingHandle === 'right') {
        newEnd = Math.min(uiSnap.duration, Math.max(currentTime, prevBounds.start + 0.1)); // Min 0.1s width
      }
      
      return { start: newStart, end: newEnd };
    });
  }, [isResizing, resizingToken, resizingHandle, getTimeFromPosition, uiSnap.duration]);

  const handleResizeEnd = useCallback(async (event) => {
    if (!isResizing || !resizingToken || !tempTokenBounds) return;
    
    // Store original bounds for potential revert
    const originalBounds = {
      timeBegin: resizingToken.metadata?.timeBegin,
      timeEnd: resizingToken.metadata?.timeEnd
    };
    
    try {
      // Optimistically update the alignment token metadata in the valtio proxy
      const alignmentToken = docProxy.alignmentTokens?.find(token => token.id === resizingToken.id);
      if (alignmentToken?.metadata) {
        alignmentToken.metadata.timeBegin = tempTokenBounds.start;
        alignmentToken.metadata.timeEnd = tempTokenBounds.end;
      }

      // Update token metadata via API
      await client.tokens.setMetadata(resizingToken.id, {
        timeBegin: tempTokenBounds.start,
        timeEnd: tempTokenBounds.end
      });

      // Clear selection state
      if (handleAlignmentCreated) {
        handleAlignmentCreated();
      }
    } catch (error) {
      // Revert the optimistic update on error
      const alignmentToken = docProxy.alignmentTokens?.find(token => token.id === resizingToken.id);
      if (alignmentToken?.metadata) {
        alignmentToken.metadata.timeBegin = originalBounds.timeBegin;
        alignmentToken.metadata.timeEnd = originalBounds.timeEnd;
      }
      
      // Use the error handler which will reload on 409
      handleError(error, 'update alignment boundaries');
    } finally {
      // Reset resize state
      setIsResizing(false);
      setResizingToken(null);
      setResizingHandle(null);
      setTempTokenBounds(null);
    }
  }, [isResizing, resizingToken, tempTokenBounds, client, handleAlignmentCreated, handleError, docProxy]);

  const handleMouseMove = useCallback((event) => {
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
  }, [isResizing, isDragging, getTimeFromPosition, dragStart, handleResizeMove]);

  const handleMouseUp = useCallback((event) => {
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
  }, [isResizing, isDragging, getTimeFromPosition, dragStart, handleTimelineClick, handleSelectionCreate, handleResizeEnd]);

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
    const handleWheel = (event) => {
      event.preventDefault();
      
      if (event.ctrlKey || event.metaKey) {
        // CTRL+scroll: zoom in/out (modify pixels per second)
        const delta = event.deltaY > 0 ? -1 : 1; // Reverse for natural zooming
        const zoomFactor = 1.1;
        const newPixelsPerSecond = delta > 0 
          ? Math.min(100, uiSnap.pixelsPerSecond * zoomFactor)
          : Math.max(4, uiSnap.pixelsPerSecond / zoomFactor);
        handlePixelsPerSecondChange(newPixelsPerSecond);
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
  }, [uiSnap.pixelsPerSecond, handlePixelsPerSecondChange]);
  
  // Smooth needle movement with auto-scroll
  useEffect(() => {
    const updateNeedle = () => {
      if (needleRef.current && timelineRef.current && mediaElement && uiSnap.pixelsPerSecond > 0) {
        const currentTime = mediaElement.currentTime;
        const position = currentTime * uiSnap.pixelsPerSecond;
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
      
      if (uiSnap.isPlaying && mediaElement) {
        animationFrameRef.current = requestAnimationFrame(updateNeedle);
      }
    };

    if (uiSnap.isPlaying && mediaElement) {
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
  }, [uiSnap.isPlaying, mediaElement, uiSnap.pixelsPerSecond]);
  
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
      if (!parsedDocument.document.mediaUrl || !uiSnap.duration || waveformImage || timelineWidth < 100) return;
      
      setIsLoadingWaveform(true);
      
      let audioHash = null;
      let cacheKey = null;
      
      try {
        const authenticatedMediaUrl = getAuthenticatedMediaUrl(parsedDocument.document.mediaUrl);
        const response = await fetch(authenticatedMediaUrl);
        const arrayBuffer = await response.arrayBuffer();
        
        // Generate hash from audio data for caching
        audioHash = await generateAudioHash(arrayBuffer);
        cacheKey = getCacheKey(audioHash, timelineWidth, uiSnap.duration);
        
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

    if (uiSnap.duration > 0 && timelineWidth > 0) {
      generateWaveformImage();
    }
  }, [parsedDocument.document.mediaUrl, uiSnap.duration, timelineWidth, waveformImage, getAuthenticatedMediaUrl]);

  return {
    // State
    isDragging,
    tempSelection,
    waveformImage,
    isLoadingWaveform,
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
    handleTimelineClick,
    handleSelectionCreate,
    handleAlignmentCreated,
    
    // Refs
    timelineRef,
    needleRef,
    timelineContainerRef,
    
    // State setters for external use
    setTimelineScrollLeft,
    setWaveformImage,
    
    // Constants
    TIMELINE_HEIGHT
  };
};