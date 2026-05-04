import type {
  MediaSource,
  MutedRange,
  TimelineClip,
  TimelineTrack,
  TrackKind,
} from './types';

export const TRACK_HEIGHT = 84;

export const MIN_CLIP_MS = 180;

export const DEFAULT_ZOOM = 60;

export const MIN_ZOOM = 24;

export const MAX_ZOOM = 240;

const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);

export function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function extensionOf(path: string) {
  const fileName = basename(path);
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex === -1) {
    return '';
  }

  return fileName.slice(dotIndex + 1).toLowerCase();
}

export function detectMediaType(path: string): MediaSource['kind'] | null {
  const extension = extensionOf(path);

  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }

  return null;
}

export function isSupportedMediaPath(path: string) {
  return detectMediaType(path) !== null;
}

export function hashAccent(seed: string) {
  const accents = ['#facc15', '#f59e0b', '#fbbf24', '#f97316', '#fde047'];
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }

  return accents[Math.abs(hash) % accents.length];
}

export function msToPx(milliseconds: number, zoom: number) {
  return (milliseconds / 1000) * zoom;
}

export function pxToMs(pixels: number, zoom: number) {
  return (pixels / zoom) * 1000;
}

export function clipDurationMs(clip: TimelineClip) {
  return clip.outPointMs - clip.inPointMs;
}

export function clipEndMs(clip: TimelineClip) {
  return clip.startMs + clipDurationMs(clip);
}

export function formatTimecode(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor((milliseconds % 1000) / 40);

  return `${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

export function formatCompactDuration(milliseconds: number) {
  const roundedSeconds = Math.max(1, Math.round(milliseconds / 1000));
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function buildDefaultTracks(): TimelineTrack[] {
  return [
    { id: 'track-video-2', kind: 'video', name: 'V2', order: 4 },
    { id: 'track-video-1', kind: 'video', name: 'V1', order: 3 },
    { id: 'track-audio-2', kind: 'audio', name: 'A2', order: 2 },
    { id: 'track-audio-1', kind: 'audio', name: 'A1', order: 1 },
  ];
}

export function trackSortDescending(left: TimelineTrack, right: TimelineTrack) {
  return right.order - left.order;
}

export function getTimelineDuration(clips: TimelineClip[]) {
  const clipMax = clips.reduce((maxValue, clip) => {
    return Math.max(maxValue, clipEndMs(clip));
  }, 0);

  return Math.max(clipMax, 15000);
}

export function timelineSuggestedName(sources: MediaSource[]) {
  const firstName = sources[0]?.name ?? 'media-editor';
  const sanitized = firstName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_]+/g, '-');

  return sanitized || 'media-editor';
}

export function mergeMutedRanges(ranges: MutedRange[]) {
  if (ranges.length === 0) {
    return ranges;
  }

  const sorted = [...ranges].sort((left, right) => left.startMs - right.startMs);
  const merged: MutedRange[] = [];

  for (const range of sorted) {
    const last = merged.at(-1);

    if (!last) {
      merged.push({ ...range });
      continue;
    }

    if (range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

export function isClipMutedAt(clip: TimelineClip, localTimeMs: number) {
  return clip.mutedRanges.some(
    (range) => localTimeMs >= range.startMs && localTimeMs < range.endMs,
  );
}

export function canPlaceSourceOnTrack(source: MediaSource, trackKind: TrackKind) {
  if (trackKind === 'video') {
    return source.hasVideo;
  }

  return source.hasAudio;
}

export function findDominantResolution(sources: MediaSource[]) {
  const firstVideo = sources.find((source) => source.hasVideo && source.width && source.height);

  if (!firstVideo) {
    return { width: 1280, height: 720 };
  }

  return {
    width: firstVideo.width ?? 1280,
    height: firstVideo.height ?? 720,
  };
}

export function rulerStepForZoom(zoom: number) {
  if (zoom >= 180) {
    return 1000;
  }

  if (zoom >= 120) {
    return 2000;
  }

  if (zoom >= 72) {
    return 5000;
  }

  if (zoom >= 40) {
    return 10000;
  }

  return 30000;
}

export function formatRulerLabel(milliseconds: number, stepMs: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (stepMs < 5000) {
    const millisecondsRemainder = Math.floor((milliseconds % 1000) / 10);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${millisecondsRemainder
      .toString()
      .padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}