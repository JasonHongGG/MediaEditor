import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Film,
  FolderOpen,
  Minus,
  MousePointer2,
  Music2,
  Pause,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  ZoomIn,
} from 'lucide-react';
import { createLogger } from '../../utils/logger';
import {
  basename,
  buildDefaultTracks,
  canPlaceSourceOnTrack,
  clamp,
  clipDurationMs,
  clipEndMs,
  createId,
  DEFAULT_ZOOM,
  detectMediaType,
  findDominantResolution,
  formatCompactDuration,
  formatRulerLabel,
  formatTimecode,
  getTimelineDuration,
  hashAccent,
  isClipMutedAt,
  isSupportedMediaPath,
  MAX_ZOOM,
  mergeMutedRanges,
  MIN_CLIP_MS,
  MIN_ZOOM,
  msToPx,
  pxToMs,
  rulerStepForZoom,
  timelineSuggestedName,
  TRACK_HEIGHT,
  trackSortDescending,
} from './editorUtils';
import type {
  EditorTool,
  MediaEditorState,
  MediaSource,
  MutedRange,
  PendingExportSession,
  TimelineClip,
  TimelineTrack,
} from './types';
import styles from './MediaEditorExperience.module.css';

const log = createLogger('MediaEditorExperience');

type InteractionState =
  | {
      type: 'move';
      clipId: string;
      startClientX: number;
      originStartMs: number;
      previewStartMs: number;
      previewTrackId: string;
    }
  | {
      type: 'trim-start';
      clipId: string;
      startClientX: number;
      originStartMs: number;
      originInPointMs: number;
      previewStartMs: number;
      previewInPointMs: number;
    }
  | {
      type: 'trim-end';
      clipId: string;
      startClientX: number;
      originOutPointMs: number;
      previewOutPointMs: number;
    }
  | {
      type: 'mute-range';
      clipId: string;
      localStartMs: number;
      localEndMs: number;
    };

type Action =
  | { type: 'add-sources'; sources: MediaSource[] }
  | { type: 'set-selection'; clipIds: string[] }
  | { type: 'add-clip'; sourceId: string; trackId: string; startMs: number }
  | { type: 'move-clip'; clipId: string; trackId: string; startMs: number }
  | { type: 'trim-clip-start'; clipId: string; startMs: number; inPointMs: number }
  | { type: 'trim-clip-end'; clipId: string; outPointMs: number }
  | { type: 'split-clip'; clipId: string; atMs: number }
  | { type: 'delete-selected' }
  | { type: 'set-playhead'; playheadMs: number }
  | { type: 'set-playing'; isPlaying: boolean }
  | { type: 'set-zoom'; zoom: number }
  | { type: 'set-tool'; tool: EditorTool }
  | { type: 'add-track'; kind: TimelineTrack['kind'] }
  | { type: 'add-muted-range'; clipId: string; startMs: number; endMs: number }
  | { type: 'remove-muted-range'; clipId: string; rangeId: string };

const initialState: MediaEditorState = {
  sources: [],
  tracks: buildDefaultTracks(),
  clips: [],
  selectedClipIds: [],
  playheadMs: 0,
  zoom: DEFAULT_ZOOM,
  isPlaying: false,
  activeTool: 'select',
};

function reducer(state: MediaEditorState, action: Action): MediaEditorState {
  switch (action.type) {
    case 'add-sources': {
      const existingPaths = new Set(state.sources.map((source) => source.path));
      const nextSources = action.sources.filter((source) => !existingPaths.has(source.path));

      if (nextSources.length === 0) {
        return state;
      }

      return {
        ...state,
        sources: [...state.sources, ...nextSources],
      };
    }

    case 'set-selection':
      return {
        ...state,
        selectedClipIds: action.clipIds,
      };

    case 'add-clip': {
      const source = state.sources.find((candidate) => candidate.id === action.sourceId);
      if (!source) {
        return state;
      }

      const newClip: TimelineClip = {
        id: createId('clip'),
        sourceId: action.sourceId,
        trackId: action.trackId,
        startMs: Math.max(0, action.startMs),
        inPointMs: 0,
        outPointMs: source.durationMs,
        mutedRanges: [],
      };

      return {
        ...state,
        clips: [...state.clips, newClip],
        selectedClipIds: [newClip.id],
        activeTool: 'select',
      };
    }

    case 'move-clip':
      return {
        ...state,
        clips: state.clips.map((clip) =>
          clip.id === action.clipId
            ? { ...clip, startMs: Math.max(0, action.startMs), trackId: action.trackId }
            : clip,
        ),
      };

    case 'trim-clip-start':
      return {
        ...state,
        clips: state.clips.map((clip) =>
          clip.id === action.clipId
            ? {
                ...clip,
                startMs: action.startMs,
                inPointMs: action.inPointMs,
                // Muted ranges live in clip-local time, so trimming the head shifts them left.
                mutedRanges: clip.mutedRanges
                  .map((range) => ({
                    ...range,
                    startMs: clamp(
                      range.startMs - (action.inPointMs - clip.inPointMs),
                      0,
                      clip.outPointMs - action.inPointMs,
                    ),
                    endMs: clamp(
                      range.endMs - (action.inPointMs - clip.inPointMs),
                      0,
                      clip.outPointMs - action.inPointMs,
                    ),
                  }))
                  .filter((range) => range.endMs - range.startMs >= 40),
              }
            : clip,
        ),
      };

    case 'trim-clip-end':
      return {
        ...state,
        clips: state.clips.map((clip) =>
          clip.id === action.clipId
            ? {
                ...clip,
                outPointMs: action.outPointMs,
                mutedRanges: clip.mutedRanges
                  .map((range) => ({
                    ...range,
                    startMs: clamp(range.startMs, 0, action.outPointMs - clip.inPointMs),
                    endMs: clamp(range.endMs, 0, action.outPointMs - clip.inPointMs),
                  }))
                  .filter((range) => range.endMs - range.startMs >= 40),
              }
            : clip,
        ),
      };

    case 'split-clip': {
      const clip = state.clips.find((candidate) => candidate.id === action.clipId);
      if (!clip) {
        return state;
      }

      const splitOffsetMs = action.atMs - clip.startMs;
      if (splitOffsetMs <= MIN_CLIP_MS || clipDurationMs(clip) - splitOffsetMs <= MIN_CLIP_MS) {
        return state;
      }

      const splitInPointMs = clip.inPointMs + splitOffsetMs;
      const leftClip: TimelineClip = {
        ...clip,
        outPointMs: splitInPointMs,
        mutedRanges: clip.mutedRanges.filter((range) => range.startMs < splitOffsetMs),
      };
      const rightClip: TimelineClip = {
        ...clip,
        id: createId('clip'),
        startMs: action.atMs,
        inPointMs: splitInPointMs,
        mutedRanges: clip.mutedRanges
          .filter((range) => range.endMs > splitOffsetMs)
          .map((range) => ({
            ...range,
            id: createId('mute'),
            startMs: Math.max(0, range.startMs - splitOffsetMs),
            endMs: Math.max(0, range.endMs - splitOffsetMs),
          })),
      };

      return {
        ...state,
        clips: state.clips.flatMap((candidate) => {
          if (candidate.id !== clip.id) {
            return [candidate];
          }

          return [leftClip, rightClip];
        }),
        selectedClipIds: [rightClip.id],
        activeTool: 'select',
      };
    }

    case 'delete-selected':
      if (state.selectedClipIds.length === 0) {
        return state;
      }

      return {
        ...state,
        clips: state.clips.filter((clip) => !state.selectedClipIds.includes(clip.id)),
        selectedClipIds: [],
      };

    case 'set-playhead':
      return {
        ...state,
        playheadMs: Math.max(0, action.playheadMs),
      };

    case 'set-playing':
      return {
        ...state,
        isPlaying: action.isPlaying,
      };

    case 'set-zoom':
      return {
        ...state,
        zoom: clamp(action.zoom, MIN_ZOOM, MAX_ZOOM),
      };

    case 'set-tool':
      return {
        ...state,
        activeTool: action.tool,
      };

    case 'add-track': {
      const currentOrders = state.tracks.map((track) => track.order);
      const nextOrder = action.kind === 'video' ? Math.max(...currentOrders) + 1 : Math.min(...currentOrders) - 1;
      const nextCount = state.tracks.filter((track) => track.kind === action.kind).length + 1;
      const nextTrack: TimelineTrack = {
        id: createId(`track-${action.kind}`),
        kind: action.kind,
        name: `${action.kind === 'video' ? 'V' : 'A'}${nextCount}`,
        order: nextOrder,
      };

      return {
        ...state,
        tracks: [...state.tracks, nextTrack],
      };
    }

    case 'add-muted-range':
      return {
        ...state,
        clips: state.clips.map((clip) => {
          if (clip.id !== action.clipId) {
            return clip;
          }

          const startMs = Math.max(0, Math.min(action.startMs, action.endMs));
          const endMs = Math.max(action.startMs, action.endMs);
          const nextRange: MutedRange = {
            id: createId('mute'),
            startMs,
            endMs,
          };

          return {
            ...clip,
            mutedRanges: mergeMutedRanges([...clip.mutedRanges, nextRange]),
          };
        }),
        activeTool: 'select',
      };

    case 'remove-muted-range':
      return {
        ...state,
        clips: state.clips.map((clip) =>
          clip.id === action.clipId
            ? { ...clip, mutedRanges: clip.mutedRanges.filter((range) => range.id !== action.rangeId) }
            : clip,
        ),
      };

    default:
      return state;
  }
}

async function probeMediaSource(path: string): Promise<MediaSource> {
  const name = basename(path);
  const kind = detectMediaType(path) ?? 'video';
  const url = convertFileSrc(path);
  const element = document.createElement(kind === 'video' ? 'video' : 'audio');

  element.preload = 'metadata';
  element.src = url;

  const metadata = await new Promise<{
    durationMs: number;
    width?: number;
    height?: number;
    thumbnailUrl?: string;
  }>((resolve, reject) => {
    const onError = () => reject(new Error(`Failed to read metadata for ${name}`));
    const onLoaded = async () => {
      const durationMs = Number.isFinite(element.duration) ? Math.max(1000, Math.round(element.duration * 1000)) : 1000;

      if (kind !== 'video') {
        resolve({ durationMs });
        return;
      }

      const video = element as HTMLVideoElement;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      let thumbnailUrl: string | undefined;

      try {
        video.currentTime = Math.min(0.25, Math.max(0.05, video.duration / 10));
        await new Promise<void>((thumbnailResolve) => {
          const onSeeked = () => {
            thumbnailResolve();
            video.removeEventListener('seeked', onSeeked);
          };

          video.addEventListener('seeked', onSeeked);
          if (video.readyState >= 2) {
            thumbnailResolve();
            video.removeEventListener('seeked', onSeeked);
          }
        });

        const canvas = document.createElement('canvas');
        canvas.width = 240;
        canvas.height = 140;
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbnailUrl = canvas.toDataURL('image/jpeg', 0.72);
        }
      } catch {
        thumbnailUrl = undefined;
      }

      resolve({ durationMs, width, height, thumbnailUrl });
    };

    element.addEventListener('loadedmetadata', onLoaded, { once: true });
    element.addEventListener('error', onError, { once: true });
  });

  element.removeAttribute('src');
  element.load();

  return {
    id: createId('source'),
    name,
    path,
    url,
    kind,
    durationMs: metadata.durationMs,
    hasVideo: kind === 'video',
    hasAudio: true,
    width: metadata.width,
    height: metadata.height,
    thumbnailUrl: metadata.thumbnailUrl,
    accent: hashAccent(name),
  };
}

export const MediaEditorExperience: React.FC = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isImporting, setIsImporting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const [playAnchor, setPlayAnchor] = useState<{ originPlayheadMs: number; startedAt: number } | null>(null);

  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  const tracks = useMemo(() => [...state.tracks].sort(trackSortDescending), [state.tracks]);
  const sourceMap = useMemo(() => new Map(state.sources.map((source) => [source.id, source])), [state.sources]);
  const trackMap = useMemo(() => new Map(state.tracks.map((track) => [track.id, track])), [state.tracks]);
  const timelineDurationMs = useMemo(() => getTimelineDuration(state.clips), [state.clips]);
  const timelineWidthPx = useMemo(
    () => Math.max(1200, Math.round(msToPx(timelineDurationMs, state.zoom) + 240)),
    [timelineDurationMs, state.zoom],
  );
  const selectedClip = useMemo(
    () => state.clips.find((clip) => clip.id === state.selectedClipIds[0]) ?? null,
    [state.clips, state.selectedClipIds],
  );
  const activeClips = useMemo(
    () => state.clips.filter((clip) => state.playheadMs >= clip.startMs && state.playheadMs < clipEndMs(clip)),
    [state.clips, state.playheadMs],
  );
  const activeVideoClip = useMemo(() => {
    return [...activeClips]
      .filter((clip) => trackMap.get(clip.trackId)?.kind === 'video' && sourceMap.get(clip.sourceId)?.hasVideo)
      .sort((left, right) => (trackMap.get(right.trackId)?.order ?? 0) - (trackMap.get(left.trackId)?.order ?? 0))[0] ?? null;
  }, [activeClips, sourceMap, trackMap]);
  const activeAudioClips = useMemo(() => {
    return activeClips.filter((clip) => {
      const source = sourceMap.get(clip.sourceId);
      if (!source?.hasAudio) {
        return false;
      }

      const localTimeMs = state.playheadMs - clip.startMs;
      return !isClipMutedAt(clip, localTimeMs);
    });
  }, [activeClips, sourceMap, state.playheadMs]);
  const dominantResolution = useMemo(() => findDominantResolution(state.sources), [state.sources]);
  const rulerStepMs = useMemo(() => rulerStepForZoom(state.zoom), [state.zoom]);
  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];

    for (let current = 0; current <= timelineDurationMs + rulerStepMs; current += rulerStepMs) {
      ticks.push(current);
    }

    return ticks;
  }, [rulerStepMs, timelineDurationMs]);

  const currentVideoSource = activeVideoClip ? sourceMap.get(activeVideoClip.sourceId) ?? null : null;
  const currentVideoLocalMs = activeVideoClip
    ? activeVideoClip.inPointMs + (state.playheadMs - activeVideoClip.startMs)
    : 0;

  const importPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths)].filter(isSupportedMediaPath);
    if (uniquePaths.length === 0) {
      return;
    }

    setIsImporting(true);
    setErrorMessage(null);

    try {
      const nextSources = await Promise.all(uniquePaths.map((path) => probeMediaSource(path)));
      dispatch({ type: 'add-sources', sources: nextSources });
      log.info('Imported media sources', nextSources.map((source) => source.name));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to import media.';
      setErrorMessage(message);
      log.error('Failed to import media', error);
    } finally {
      setIsImporting(false);
    }
  }, []);

  const handleOpenDialog = useCallback(async () => {
    const selection = await open({
      multiple: true,
      title: 'Import video or audio',
      filters: [
        {
          name: 'Media',
          extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
        },
      ],
    });

    if (!selection) {
      return;
    }

    const paths = Array.isArray(selection) ? selection : [selection];
    await importPaths(paths);
  }, [importPaths]);

  const openExportWindow = useCallback(async () => {
    if (state.clips.length === 0) {
      return;
    }

    const session: PendingExportSession = {
      sources: state.sources,
      tracks: state.tracks,
      clips: state.clips,
      timelineDurationMs,
      suggestedName: timelineSuggestedName(state.sources),
      dominantWidth: dominantResolution.width,
      dominantHeight: dominantResolution.height,
    };

    await invoke('set_pending_export_session', { session });

    const existingWindow = await WebviewWindow.getByLabel('export');

    if (existingWindow) {
      await existingWindow.show();
      await existingWindow.setFocus();
      await emitTo('export', 'editor/export-session-updated', session);
      return;
    }

    const exportWindow = new WebviewWindow('export', {
      url: '/?view=export',
      title: 'Export',
      width: 460,
      height: 620,
      resizable: false,
      center: true,
      focus: true,
    });

    exportWindow.once('tauri://created', async () => {
      await emitTo('export', 'editor/export-session-updated', session);
    });

    exportWindow.once('tauri://error', (event) => {
      log.error('Failed to open export window', event.payload);
      setErrorMessage('Unable to open export window.');
    });
  }, [dominantResolution.height, dominantResolution.width, state.clips, state.sources, state.tracks, timelineDurationMs]);

  const togglePlay = useCallback(() => {
    if (state.isPlaying) {
      dispatch({ type: 'set-playing', isPlaying: false });
      setPlayAnchor(null);
      return;
    }

    setPlayAnchor({ originPlayheadMs: state.playheadMs, startedAt: performance.now() });
    dispatch({ type: 'set-playing', isPlaying: true });
  }, [state.isPlaying, state.playheadMs]);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let unlistenDrag: (() => void) | undefined;

    void currentWindow.onDragDropEvent((event) => {
      if (event.payload.type === 'over') {
        setDropActive(true);
        return;
      }

      if (event.payload.type === 'drop') {
        setDropActive(false);
        void importPaths(event.payload.paths);
        return;
      }

      setDropActive(false);
    }).then((unlisten) => {
      unlistenDrag = unlisten;
    });

    return () => {
      unlistenDrag?.();
    };
  }, [importPaths]);

  useEffect(() => {
    if (!state.isPlaying || !playAnchor) {
      return undefined;
    }

    let frame = 0;

    const step = (timestamp: number) => {
      const elapsed = timestamp - playAnchor.startedAt;
      const nextPlayhead = playAnchor.originPlayheadMs + elapsed;

      if (nextPlayhead >= timelineDurationMs) {
        dispatch({ type: 'set-playhead', playheadMs: timelineDurationMs });
        dispatch({ type: 'set-playing', isPlaying: false });
        setPlayAnchor(null);
        return;
      }

      startTransition(() => {
        dispatch({ type: 'set-playhead', playheadMs: nextPlayhead });
      });

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
  }, [playAnchor, state.isPlaying, timelineDurationMs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      }

      if (event.code === 'Delete' || event.code === 'Backspace') {
        dispatch({ type: 'delete-selected' });
      }

      if (event.key.toLowerCase() === 's' && selectedClip) {
        dispatch({ type: 'split-clip', clipId: selectedClip.id, atMs: state.playheadMs });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClip, state.playheadMs, togglePlay]);

  useEffect(() => {
    const element = previewVideoRef.current;

    if (!element) {
      return;
    }

    if (!currentVideoSource || !activeVideoClip) {
      element.pause();
      element.removeAttribute('src');
      element.load();
      return;
    }

    const expectedTime = Math.max(0, currentVideoLocalMs / 1000);
    if (element.dataset.clipId !== activeVideoClip.id) {
      element.dataset.clipId = activeVideoClip.id;
      element.src = currentVideoSource.url;
      element.currentTime = expectedTime;
    } else if (Math.abs(element.currentTime - expectedTime) > (state.isPlaying ? 0.18 : 0.04)) {
      element.currentTime = expectedTime;
    }

    if (state.isPlaying) {
      void element.play().catch(() => {
        dispatch({ type: 'set-playing', isPlaying: false });
        setPlayAnchor(null);
      });
    } else {
      element.pause();
    }
  }, [activeVideoClip, currentVideoLocalMs, currentVideoSource, state.isPlaying]);

  useEffect(() => {
    const nextActiveClipIds = new Set(activeAudioClips.map((clip) => clip.id));

    for (const [clipId, element] of audioRefs.current.entries()) {
      if (!nextActiveClipIds.has(clipId)) {
        element.pause();
      }
    }

    for (const clip of activeAudioClips) {
      const element = audioRefs.current.get(clip.id);
      if (!element) {
        continue;
      }

      const expectedTime = (clip.inPointMs + (state.playheadMs - clip.startMs)) / 1000;
      if (Math.abs(element.currentTime - expectedTime) > (state.isPlaying ? 0.18 : 0.04)) {
        element.currentTime = expectedTime;
      }

      if (state.isPlaying) {
        void element.play().catch(() => undefined);
      } else {
        element.pause();
      }
    }
  }, [activeAudioClips, state.isPlaying, state.playheadMs]);

  useEffect(() => {
    if (!interaction) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (interaction.type === 'move') {
        const nextStart = Math.max(0, interaction.originStartMs + pxToMs(event.clientX - interaction.startClientX, state.zoom));
        const nextTrackId = (() => {
          if (!trackAreaRef.current) {
            return interaction.previewTrackId;
          }

          const bounds = trackAreaRef.current.getBoundingClientRect();
          const relativeY = event.clientY - bounds.top + trackAreaRef.current.scrollTop;
          const trackIndex = clamp(Math.floor(relativeY / TRACK_HEIGHT), 0, tracks.length - 1);
          return tracks[trackIndex]?.id ?? interaction.previewTrackId;
        })();

        setInteraction({ ...interaction, previewStartMs: nextStart, previewTrackId: nextTrackId });
        return;
      }

      if (interaction.type === 'trim-start') {
        const clip = state.clips.find((candidate) => candidate.id === interaction.clipId);
        const source = clip ? sourceMap.get(clip.sourceId) : null;
        if (!clip || !source) {
          return;
        }

        const deltaMs = pxToMs(event.clientX - interaction.startClientX, state.zoom);
        const nextInPointMs = clamp(interaction.originInPointMs + deltaMs, 0, clip.outPointMs - MIN_CLIP_MS);
        const nextStartMs = interaction.originStartMs + (nextInPointMs - interaction.originInPointMs);

        setInteraction({
          ...interaction,
          previewStartMs: nextStartMs,
          previewInPointMs: clamp(nextInPointMs, 0, source.durationMs),
        });
        return;
      }

      if (interaction.type === 'trim-end') {
        const clip = state.clips.find((candidate) => candidate.id === interaction.clipId);
        const source = clip ? sourceMap.get(clip.sourceId) : null;
        if (!clip || !source) {
          return;
        }

        const deltaMs = pxToMs(event.clientX - interaction.startClientX, state.zoom);
        const nextOutPointMs = clamp(interaction.originOutPointMs + deltaMs, clip.inPointMs + MIN_CLIP_MS, source.durationMs);
        setInteraction({ ...interaction, previewOutPointMs: nextOutPointMs });
        return;
      }

      if (interaction.type === 'mute-range') {
        const clipElement = document.querySelector<HTMLElement>(`[data-clip-id="${interaction.clipId}"]`);
        const clip = state.clips.find((candidate) => candidate.id === interaction.clipId);
        if (!clip || !clipElement) {
          return;
        }

        const clipBounds = clipElement.getBoundingClientRect();
        const localPixel = clamp(event.clientX - clipBounds.left, 0, clipBounds.width);
        const localTimeMs = pxToMs(localPixel, state.zoom);
        setInteraction({
          ...interaction,
          localEndMs: clamp(localTimeMs, 0, clip.outPointMs - clip.inPointMs),
        });
      }
    };

    const handlePointerUp = () => {
      if (interaction.type === 'move') {
        dispatch({
          type: 'move-clip',
          clipId: interaction.clipId,
          trackId: interaction.previewTrackId,
          startMs: interaction.previewStartMs,
        });
      }

      if (interaction.type === 'trim-start') {
        dispatch({
          type: 'trim-clip-start',
          clipId: interaction.clipId,
          startMs: Math.max(0, interaction.previewStartMs),
          inPointMs: interaction.previewInPointMs,
        });
      }

      if (interaction.type === 'trim-end') {
        dispatch({
          type: 'trim-clip-end',
          clipId: interaction.clipId,
          outPointMs: interaction.previewOutPointMs,
        });
      }

      if (interaction.type === 'mute-range') {
        dispatch({
          type: 'add-muted-range',
          clipId: interaction.clipId,
          startMs: Math.min(interaction.localStartMs, interaction.localEndMs),
          endMs: Math.max(interaction.localStartMs, interaction.localEndMs),
        });
      }

      setInteraction(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [interaction, sourceMap, state.clips, state.zoom, tracks]);

  const handleTimelineSeek = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!timelineScrollRef.current) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const pixel = event.clientX - bounds.left + timelineScrollRef.current.scrollLeft;
    dispatch({ type: 'set-playhead', playheadMs: clamp(pxToMs(pixel, state.zoom), 0, timelineDurationMs) });
    dispatch({ type: 'set-playing', isPlaying: false });
    setPlayAnchor(null);
  }, [state.zoom, timelineDurationMs]);

  const handleClipPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, clip: TimelineClip) => {
    event.stopPropagation();
    dispatch({ type: 'set-selection', clipIds: [clip.id] });
    dispatch({ type: 'set-playing', isPlaying: false });
    setPlayAnchor(null);

    if (state.activeTool === 'mute') {
      const bounds = event.currentTarget.getBoundingClientRect();
      const localPixel = clamp(event.clientX - bounds.left, 0, bounds.width);
      const localTimeMs = clamp(pxToMs(localPixel, state.zoom), 0, clip.outPointMs - clip.inPointMs);
      setInteraction({ type: 'mute-range', clipId: clip.id, localStartMs: localTimeMs, localEndMs: localTimeMs });
      return;
    }

    setInteraction({
      type: 'move',
      clipId: clip.id,
      startClientX: event.clientX,
      originStartMs: clip.startMs,
      previewStartMs: clip.startMs,
      previewTrackId: clip.trackId,
    });
  }, [state.activeTool, state.zoom]);

  const handleTrimStartPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>, clip: TimelineClip) => {
    event.stopPropagation();
    setInteraction({
      type: 'trim-start',
      clipId: clip.id,
      startClientX: event.clientX,
      originStartMs: clip.startMs,
      originInPointMs: clip.inPointMs,
      previewStartMs: clip.startMs,
      previewInPointMs: clip.inPointMs,
    });
  }, []);

  const handleTrimEndPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>, clip: TimelineClip) => {
    event.stopPropagation();
    setInteraction({
      type: 'trim-end',
      clipId: clip.id,
      startClientX: event.clientX,
      originOutPointMs: clip.outPointMs,
      previewOutPointMs: clip.outPointMs,
    });
  }, []);

  const handleTrackDrop = useCallback((event: React.DragEvent<HTMLDivElement>, trackId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('application/x-media-source');
    if (!sourceId || !timelineScrollRef.current) {
      return;
    }

    const track = trackMap.get(trackId);
    const source = sourceMap.get(sourceId);
    if (!track || !source || !canPlaceSourceOnTrack(source, track.kind)) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left + timelineScrollRef.current.scrollLeft;
    const startMs = clamp(pxToMs(localX, state.zoom), 0, timelineDurationMs + 30000);
    dispatch({ type: 'add-clip', sourceId, trackId, startMs });
  }, [sourceMap, state.zoom, timelineDurationMs, trackMap]);

  const clipsByTrack = useMemo(() => {
    const buckets = new Map<string, Array<{ clip: TimelineClip; leftPx: number; widthPx: number; selected: boolean }>>();

    for (const track of tracks) {
      buckets.set(track.id, []);
    }

    for (const clip of state.clips) {
      const interactionForClip = interaction && interaction.clipId === clip.id ? interaction : null;
      const effectiveStartMs = interactionForClip?.type === 'move'
        ? interactionForClip.previewStartMs
        : interactionForClip?.type === 'trim-start'
          ? interactionForClip.previewStartMs
          : clip.startMs;
      const effectiveTrackId = interactionForClip?.type === 'move' ? interactionForClip.previewTrackId : clip.trackId;
      const effectiveInPointMs = interactionForClip?.type === 'trim-start' ? interactionForClip.previewInPointMs : clip.inPointMs;
      const effectiveOutPointMs = interactionForClip?.type === 'trim-end' ? interactionForClip.previewOutPointMs : clip.outPointMs;

      buckets.get(effectiveTrackId)?.push({
        clip,
        leftPx: msToPx(effectiveStartMs, state.zoom),
        widthPx: msToPx(effectiveOutPointMs - effectiveInPointMs, state.zoom),
        selected: state.selectedClipIds.includes(clip.id),
      });
    }

    return buckets;
  }, [interaction, state.clips, state.selectedClipIds, state.zoom, tracks]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={styles.shell}>
      <AnimatePresence>
        {dropActive && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={styles.dropOverlay}>
            <Upload size={26} />
          </motion.div>
        )}
      </AnimatePresence>

      <aside className={styles.sidebar}>
        <div className={styles.panelGlow} />
        <div className={styles.sidebarContent}>
          <div className={styles.sidebarHeader}>
            <button type="button" className={styles.importButton} onClick={() => void handleOpenDialog()} disabled={isImporting}>
              <FolderOpen size={15} />
            </button>
          </div>

          <div className={styles.assetList}>
            {state.sources.length === 0 && (
              <button type="button" className={styles.emptyBin} onClick={() => void handleOpenDialog()}>
                <Upload size={20} />
                <span>{isImporting ? 'loading' : 'drop / open'}</span>
              </button>
            )}

            <AnimatePresence initial={false}>
              {state.sources.map((source) => (
                <motion.button
                  key={source.id}
                  type="button"
                  draggable
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className={styles.assetCard}
                  style={{ '--clip-accent': source.accent } as React.CSSProperties}
                  onDragStartCapture={(event: React.DragEvent<HTMLButtonElement>) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('application/x-media-source', source.id);
                  }}
                >
                  <div className={styles.assetVisual}>
                    {source.thumbnailUrl ? (
                      <img src={source.thumbnailUrl} alt={source.name} />
                    ) : (
                      <div className={styles.assetFallbackIcon}>
                        {source.kind === 'video' ? <Film size={18} /> : <Music2 size={18} />}
                      </div>
                    )}
                  </div>
                  <div className={styles.assetMeta}>
                    <span className={styles.assetName}>{source.name}</span>
                    <span className={styles.assetSubline}>{formatCompactDuration(source.durationMs)}</span>
                  </div>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </aside>

      <section className={styles.stage}>
        <div className={styles.previewPanel}>
          <div className={styles.previewFrame}>
            {currentVideoSource ? (
              <video ref={previewVideoRef} className={styles.previewVideo} muted playsInline preload="auto" />
            ) : (
              <div className={styles.previewIdle}>
                <Sparkles size={22} />
                <span>{activeAudioClips.length > 0 ? 'audio active' : 'preview'}</span>
              </div>
            )}

            {activeAudioClips.length > 0 && !currentVideoSource && (
              <div className={styles.audioPulse}>
                <span />
                <span />
                <span />
                <span />
              </div>
            )}

            <div className={styles.previewHud}>
              <button type="button" className={styles.transportButton} onClick={togglePlay}>
                {state.isPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <div className={styles.transportMeta}>
                <span>{formatTimecode(state.playheadMs)}</span>
                <span>{formatTimecode(timelineDurationMs)}</span>
              </div>
            </div>
          </div>

          <div className={styles.previewStrip}>
            <button type="button" className={styles.iconChip} onClick={() => dispatch({ type: 'set-playhead', playheadMs: 0 })}>
              <Minus size={15} />
            </button>
            <button type="button" className={styles.iconChip} onClick={togglePlay}>
              {state.isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button type="button" className={styles.iconChip} onClick={openExportWindow} disabled={state.clips.length === 0}>
              <Upload size={15} />
            </button>
          </div>

          <div className={styles.hiddenMediaPool}>
            {activeAudioClips.map((clip) => {
              const source = sourceMap.get(clip.sourceId);
              if (!source) {
                return null;
              }

              return (
                <audio
                  key={clip.id}
                  ref={(node) => {
                    if (node) {
                      audioRefs.current.set(clip.id, node);
                    } else {
                      audioRefs.current.delete(clip.id);
                    }
                  }}
                  src={source.url}
                  preload="auto"
                />
              );
            })}
          </div>
        </div>

        <div className={styles.timelinePanel}>
          <div className={styles.timelineToolbar}>
            <div className={styles.toolGroup}>
              <button type="button" className={`${styles.toolbarButton} ${state.activeTool === 'select' ? styles.toolbarButtonActive : ''}`} onClick={() => dispatch({ type: 'set-tool', tool: 'select' })}>
                <MousePointer2 size={16} />
              </button>
              <button type="button" className={styles.toolbarButton} onClick={() => { if (selectedClip) { dispatch({ type: 'split-clip', clipId: selectedClip.id, atMs: state.playheadMs }); } }} disabled={!selectedClip}>
                <Scissors size={16} />
              </button>
              <button type="button" className={`${styles.toolbarButton} ${state.activeTool === 'mute' ? styles.toolbarButtonActive : ''}`} onClick={() => dispatch({ type: 'set-tool', tool: state.activeTool === 'mute' ? 'select' : 'mute' })}>
                {state.activeTool === 'mute' ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <button type="button" className={styles.toolbarButton} onClick={() => dispatch({ type: 'delete-selected' })} disabled={!selectedClip}>
                <Trash2 size={16} />
              </button>
            </div>

            <div className={styles.toolGroup}>
              <button type="button" className={styles.toolbarButton} onClick={() => dispatch({ type: 'add-track', kind: 'video' })}>
                <Plus size={16} />
                <Film size={14} />
              </button>
              <button type="button" className={styles.toolbarButton} onClick={() => dispatch({ type: 'add-track', kind: 'audio' })}>
                <Plus size={16} />
                <Music2 size={14} />
              </button>
            </div>

            <div className={styles.zoomGroup}>
              <ZoomIn size={15} />
              <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} value={state.zoom} onChange={(event) => dispatch({ type: 'set-zoom', zoom: Number(event.target.value) })} />
            </div>

            <button type="button" className={styles.exportButton} onClick={openExportWindow} disabled={state.clips.length === 0}>
              <Wand2 size={16} />
            </button>
          </div>

          <div className={styles.timelineSurface}>
            <div className={styles.trackSidebar}>
              {tracks.map((track) => (
                <div key={track.id} className={styles.trackBadge}>
                  <span>{track.name}</span>
                  <span>{track.kind === 'video' ? '⋮' : '≈'}</span>
                </div>
              ))}
            </div>

            <div className={styles.timelineCanvasWrap}>
              <div className={styles.ruler} onPointerDown={handleTimelineSeek}>
                <div className={styles.rulerInner} style={{ width: `${timelineWidthPx}px` }}>
                  {rulerTicks.map((tickMs) => (
                    <div key={tickMs} className={styles.rulerTick} style={{ left: `${msToPx(tickMs, state.zoom)}px` }}>
                      <span>{formatRulerLabel(tickMs, rulerStepMs)}</span>
                    </div>
                  ))}
                  <div className={styles.playhead} style={{ left: `${msToPx(state.playheadMs, state.zoom)}px` }}>
                    <span />
                  </div>
                </div>
              </div>

              <div className={styles.trackArea} ref={trackAreaRef}>
                <div className={styles.timelineScroller} ref={timelineScrollRef}>
                  <div className={styles.timelineLanes} style={{ width: `${timelineWidthPx}px` }}>
                    {tracks.map((track) => (
                      <div key={track.id} className={`${styles.trackLane} ${track.kind === 'audio' ? styles.audioLane : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleTrackDrop(event, track.id)} onPointerDown={handleTimelineSeek}>
                        <div className={styles.trackGrid} />
                        {clipsByTrack.get(track.id)?.map(({ clip, leftPx, widthPx, selected }) => {
                          const source = sourceMap.get(clip.sourceId);
                          if (!source) {
                            return null;
                          }

                          const isAudioTrack = track.kind === 'audio';
                          const draftRange = interaction?.type === 'mute-range' && interaction.clipId === clip.id
                            ? interaction
                            : null;

                          return (
                            <motion.div
                              key={clip.id}
                              layout
                              data-clip-id={clip.id}
                              className={`${styles.clip} ${selected ? styles.clipSelected : ''} ${(source.kind === 'audio' || isAudioTrack) ? styles.audioClip : styles.videoClip}`}
                              style={{ width: `${widthPx}px`, left: `${leftPx}px`, '--clip-accent': source.accent } as React.CSSProperties}
                              onPointerDown={(event) => handleClipPointerDown(event, clip)}
                            >
                              <button type="button" className={styles.trimHandleStart} onPointerDown={(event) => handleTrimStartPointerDown(event, clip)} />
                              <div className={styles.clipInner}>
                                <div className={styles.clipHeader}>
                                  <span className={styles.clipIcon}>{source.kind === 'video' ? <Film size={14} /> : <Music2 size={14} />}</span>
                                  <span className={styles.clipName}>{source.name}</span>
                                </div>
                                <span className={styles.clipMeta}>{formatCompactDuration(clip.outPointMs - clip.inPointMs)}</span>
                                {source.hasAudio && (
                                  <div className={styles.muteLayer}>
                                    {clip.mutedRanges.map((range) => (
                                      <button key={range.id} type="button" className={styles.mutedRange} style={{ left: `${msToPx(range.startMs, state.zoom)}px`, width: `${Math.max(6, msToPx(range.endMs - range.startMs, state.zoom))}px` }} onClick={(event) => { event.stopPropagation(); dispatch({ type: 'remove-muted-range', clipId: clip.id, rangeId: range.id }); }} title="Remove mute segment" />
                                    ))}
                                    {draftRange && (
                                      <div className={styles.muteDraft} style={{ left: `${msToPx(Math.min(draftRange.localStartMs, draftRange.localEndMs), state.zoom)}px`, width: `${Math.max(4, msToPx(Math.abs(draftRange.localEndMs - draftRange.localStartMs), state.zoom))}px` }} />
                                    )}
                                  </div>
                                )}
                              </div>
                              <button type="button" className={styles.trimHandleEnd} onPointerDown={(event) => handleTrimEndPointerDown(event, clip)} />
                            </motion.div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {errorMessage && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} className={styles.errorToast}>
            <span>{errorMessage}</span>
            <button type="button" onClick={() => setErrorMessage(null)}>×</button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};