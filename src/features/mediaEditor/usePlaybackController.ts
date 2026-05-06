import React, { startTransition, useEffect, useEffectEvent, useMemo, useRef } from 'react';
import type { EditorAsset, TimelineClip } from './model';
import { clamp } from './model';
import type { EditorAction } from './editorReducer';

const PLAYING_SYNC_THRESHOLD_SECONDS = 0.18;
const PAUSED_SYNC_THRESHOLD_SECONDS = 0.04;

function syncMediaTime(element: HTMLMediaElement, expectedTime: number, isPlaying: boolean) {
  try {
    const threshold = isPlaying ? PLAYING_SYNC_THRESHOLD_SECONDS : PAUSED_SYNC_THRESHOLD_SECONDS;
    if (Math.abs(element.currentTime - expectedTime) > threshold) {
      element.currentTime = expectedTime;
    }
    return true;
  } catch {
    return false;
  }
}

interface PlaybackEntry {
  clip: TimelineClip;
  asset: EditorAsset;
}

interface UsePlaybackControllerArgs {
  isPlaying: boolean;
  playheadMs: number;
  timelineDurationMs: number;
  previewVolume: number;
  previewMuted: boolean;
  activeVideoEntry: PlaybackEntry | null;
  activeAudioEntries: PlaybackEntry[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRefs: React.RefObject<Map<string, HTMLAudioElement>>;
  dispatch: React.Dispatch<EditorAction>;
}

export function usePlaybackController({
  isPlaying,
  playheadMs,
  timelineDurationMs,
  previewVolume,
  previewMuted,
  activeVideoEntry,
  activeAudioEntries,
  videoRef,
  audioRefs,
  dispatch,
}: UsePlaybackControllerArgs) {
  const anchorRef = useRef<{ originPlayheadMs: number; startedAt: number } | null>(null);

  const stopPlayback = useEffectEvent(() => {
    anchorRef.current = null;
    dispatch({ type: 'set-playing', isPlaying: false });
  });

  const seekTo = useEffectEvent((nextPlayheadMs: number, preservePlayback = false) => {
    const boundedPlayheadMs = clamp(nextPlayheadMs, 0, timelineDurationMs);
    dispatch({ type: 'set-playhead', playheadMs: boundedPlayheadMs });

    if (preservePlayback && isPlaying) {
      anchorRef.current = {
        originPlayheadMs: boundedPlayheadMs,
        startedAt: performance.now(),
      };
      return;
    }

    stopPlayback();
  });

  const togglePlay = useEffectEvent(() => {
    if (timelineDurationMs === 0) {
      return;
    }

    if (isPlaying) {
      stopPlayback();
      return;
    }

    const originPlayheadMs = playheadMs >= timelineDurationMs ? 0 : playheadMs;
    if (originPlayheadMs !== playheadMs) {
      dispatch({ type: 'set-playhead', playheadMs: originPlayheadMs });
    }

    anchorRef.current = {
      originPlayheadMs,
      startedAt: performance.now(),
    };
    dispatch({ type: 'set-playing', isPlaying: true });
  });

  const seekBy = useEffectEvent((deltaMs: number) => {
    if (timelineDurationMs === 0) {
      return;
    }

    seekTo(playheadMs + deltaMs, isPlaying);
  });

  useEffect(() => {
    if (!isPlaying || !anchorRef.current) {
      return undefined;
    }

    let frameId = 0;
    let lastDispatchedMs = -1;

    const step = (timestamp: number) => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }

      const elapsedMs = timestamp - anchor.startedAt;
      const nextPlayheadMs = anchor.originPlayheadMs + elapsedMs;
      if (nextPlayheadMs >= timelineDurationMs) {
        dispatch({ type: 'set-playhead', playheadMs: timelineDurationMs });
        stopPlayback();
        return;
      }

      // Throttle state updates to ~30fps to reduce render pressure
      const rounded = Math.round(nextPlayheadMs);
      if (Math.abs(rounded - lastDispatchedMs) >= 33) {
        lastDispatchedMs = rounded;
        startTransition(() => {
          dispatch({ type: 'set-playhead', playheadMs: rounded });
        });
      }

      frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [dispatch, isPlaying, stopPlayback, timelineDurationMs]);

  const activeAudioIds = useMemo(
    () => new Set(activeAudioEntries.map((entry) => entry.clip.id)),
    [activeAudioEntries],
  );

  useEffect(() => {
    const element = videoRef.current;
    if (!element) {
      return;
    }

    if (!activeVideoEntry || !activeVideoEntry.asset.url) {
      element.pause();
      delete element.dataset.clipId;
      delete element.dataset.assetUrl;
      element.removeAttribute('src');
      element.load();
      return;
    }

    const expectedTime = (activeVideoEntry.clip.inPointMs + (playheadMs - activeVideoEntry.clip.startMs)) / 1000;
    const sourceChanged = element.dataset.clipId !== activeVideoEntry.clip.id
      || element.dataset.assetUrl !== activeVideoEntry.asset.url;

    if (sourceChanged) {
      element.dataset.clipId = activeVideoEntry.clip.id;
      element.dataset.assetUrl = activeVideoEntry.asset.url;
      element.src = activeVideoEntry.asset.url;
      element.load();

      const syncWhenReady = () => {
        if (element.dataset.clipId !== activeVideoEntry.clip.id) {
          return;
        }

        syncMediaTime(element, expectedTime, false);
        if (isPlaying) {
          void element.play().catch(() => {
            /* ignore transient video startup failures while the source is warming up */
          });
        }
      };

      element.addEventListener('loadedmetadata', syncWhenReady, { once: true });
      element.addEventListener('canplay', syncWhenReady, { once: true });
      return;
    }

    // During playback, let the browser's native clock run — only correct drift
    syncMediaTime(element, expectedTime, isPlaying);

    if (isPlaying) {
      if (element.paused) {
        void element.play().catch(() => {
          /* ignore transient play rejections */
        });
      }
    } else {
      element.pause();
    }
  }, [activeVideoEntry, isPlaying, playheadMs, videoRef]);

  useEffect(() => {
    for (const [clipId, element] of audioRefs.current.entries()) {
      if (!activeAudioIds.has(clipId)) {
        element.pause();
      }
    }

    for (const entry of activeAudioEntries) {
      const element = audioRefs.current.get(entry.clip.id);
      if (!element || !entry.asset.url) {
        continue;
      }

      const expectedTime = (entry.clip.inPointMs + (playheadMs - entry.clip.startMs)) / 1000;
      element.muted = previewMuted;
      element.volume = previewMuted ? 0 : previewVolume;

      syncMediaTime(element, expectedTime, isPlaying);

      if (isPlaying) {
        if (element.paused) {
          void element.play().catch(() => {
            /* ignore individual audio element failures */
          });
        }
      } else {
        element.pause();
      }
    }
  }, [activeAudioEntries, activeAudioIds, audioRefs, isPlaying, playheadMs, previewMuted, previewVolume]);

  return {
    togglePlay,
    seekTo,
    seekBy,
    stopPlayback,
  };
}