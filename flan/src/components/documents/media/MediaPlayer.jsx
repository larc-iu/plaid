import React, { useState, useRef, useEffect } from 'react';
import {
  Stack,
  Text,
  Paper,
  Button,
  Group,
  Alert,
  ActionIcon,
  Tooltip,
  Slider,
  Title
} from '@mantine/core';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconPlayerPause from '@tabler/icons-react/dist/esm/icons/IconPlayerPause.mjs';
import IconPlayerSkipBack from '@tabler/icons-react/dist/esm/icons/IconPlayerSkipBack.mjs';
import IconPlayerSkipForward from '@tabler/icons-react/dist/esm/icons/IconPlayerSkipForward.mjs';
import IconVolume from '@tabler/icons-react/dist/esm/icons/IconVolume.mjs';
import IconPlayerTrackPrev from '@tabler/icons-react/dist/esm/icons/IconPlayerTrackPrev.mjs';
import IconPlayerTrackNext from '@tabler/icons-react/dist/esm/icons/IconPlayerTrackNext.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import { useSnapshot } from 'valtio';
import documentsStore from '../../../stores/documentsStore';

// Utility function for formatting time
const formatTime = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

export const MediaPlayer = ({ mediaOps, readOnly = false }) => {
  // Destructure what we need from mediaOps
  const {
    authenticatedMediaUrl: mediaUrl,
    currentTime,
    duration,
    isPlaying,
    volume,
    handleTimeUpdate: onTimeUpdate,
    handleDurationChange: onDurationChange,
    handlePlayingChange: onPlayingChange,
    handleVolumeChange: onVolumeChange,
    handleSkipToBeginning: onSkipToBeginning,
    handleSkipToEnd: onSkipToEnd,
    setMediaElement: onMediaElementReady,
    handleSeek: onSeek,
    handleDeleteMedia: onDeleteMedia,
    projectId,
    documentId
  } = mediaOps;
  
  const storeSnap = useSnapshot(documentsStore);
  const docSnap = storeSnap[projectId]?.[documentId];
  const mediaRef = useRef(null);
  const [mediaError, setMediaError] = useState(null);
  const [mediaType, setMediaType] = useState('video');
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
                  disabled={readOnly}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>

      <Stack spacing="md">
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
            onPlayingChange && onPlayingChange(true);
          }}
          onPause={() => {
            onPlayingChange && onPlayingChange(false);
          }}
          onLoadedMetadata={(e) => {
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