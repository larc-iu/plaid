import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  Volume2,
  Trash2,
  Repeat,
} from 'lucide-react';
import { formatTime } from './formatTime.js';
import { PLAYBACK_RATES } from './useMediaOperations.js';

export const MediaPlayer = ({ mediaOps, readOnly = false }) => {
  // Destructure what we need from mediaOps
  const {
    authenticatedMediaUrl: mediaUrl,
    isLoadingMedia,
    mediaLoadError,
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
    playbackRate,
    handlePlaybackRateChange: onPlaybackRateChange,
    loopSegment,
    setLoopSegment,
  } = mediaOps;

  const mediaRef = useRef(null);
  const [mediaError, setMediaError] = useState(null);
  // 'unknown' until loadedmetadata tells us whether the file has a picture: an
  // audio-only file must never show the big black video box (it used to,
  // because the default was 'video' and the box only hid once metadata said
  // otherwise — and stayed if the file never loaded).
  const [mediaType, setMediaType] = useState('unknown');
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
        setMediaError(
          'Media format not supported by your browser. Please try MP4, WebM, MP3, or WAV files.',
        );
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
    <TooltipProvider>
      <div className="tw rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold">Recording</h3>
          </div>
          {mediaUrl && (
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    onClick={onDeleteMedia}
                    disabled={readOnly}
                    aria-label="Delete media file"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete media file</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {/* Media error. `mediaLoadError` is the fetch that builds the blob
              failing; `mediaError` is the element rejecting what it got. The
              fetch is what surfaces an auth/network failure now that <video>
              never talks to the server itself. */}
          {(mediaLoadError || mediaError) && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <p className="text-sm font-medium text-destructive">Playback Error</p>
              <p className="text-sm text-muted-foreground">
                {mediaLoadError ? `Failed to load media: ${mediaLoadError}` : mediaError}
              </p>
            </div>
          )}

          {/* The whole file has to arrive before anything is playable, so say
              so rather than showing an inert player. */}
          {isLoadingMedia && <p className="text-sm text-muted-foreground">Loading media…</p>}

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
              display: mediaType === 'video' ? 'block' : 'none',
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
          <div className="flex items-center justify-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10"
                  onClick={onSkipToBeginning}
                  aria-label="Skip to beginning"
                >
                  <SkipBack className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Skip to beginning</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10"
                  onClick={() => skipTime(-5)}
                  aria-label="Skip back 5 seconds"
                >
                  <Rewind className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Skip back 5 seconds</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  className="h-12 w-12"
                  onClick={togglePlayback}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isPlaying ? 'Pause' : 'Play'}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10"
                  onClick={() => skipTime(5)}
                  aria-label="Skip forward 5 seconds"
                >
                  <FastForward className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Skip forward 5 seconds</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10"
                  onClick={onSkipToEnd}
                  aria-label="Skip to end"
                >
                  <SkipForward className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Skip to end</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={loopSegment ? 'secondary' : 'ghost'}
                  size="icon"
                  className={cn('ml-2 h-10 w-10', loopSegment && 'text-primary')}
                  onClick={() => setLoopSegment(!loopSegment)}
                  aria-label="Loop segment"
                  aria-pressed={!!loopSegment}
                >
                  <Repeat className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{loopSegment ? 'Loop segment: on' : 'Loop segment'}</TooltipContent>
            </Tooltip>
          </div>

          {/* Time Display and Seek Bar */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-1">
              <span className="text-sm text-muted-foreground">{formatTime(currentTime || 0)}</span>
              <span className="text-sm text-muted-foreground">{formatTime(duration || 0)}</span>
            </div>

            <Slider
              value={[currentTime || 0]}
              max={duration || 100}
              onValueChange={([v]) => seekTo(v)}
              className="flex-1"
            />
          </div>

          {/* Volume and speed */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
              <Slider
                value={[volume]}
                onValueChange={([v]) => onVolumeChange(v)}
                min={0}
                max={1}
                step={0.1}
                className="w-[150px]"
                aria-label="Volume"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Speed</span>
              <Select
                value={String(playbackRate ?? 1)}
                onValueChange={(v) => onPlaybackRateChange(Number(v))}
              >
                <SelectTrigger className="h-8 w-[88px]" aria-label="Playback speed">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAYBACK_RATES.map((rate) => (
                    <SelectItem key={rate} value={String(rate)}>
                      {rate}×
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};
