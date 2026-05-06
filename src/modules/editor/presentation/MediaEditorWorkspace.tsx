import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle,
  FilePlus2,
  FileOutput,
  Film,
  FolderOpen,
  Import,
  Link2,
  Music2,
  Pause,
  Play,
  Plus,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { editorReducer, initialEditorState } from '../application/editorReducer';
import {
  basename,
  buildDefaultProjectState,
  clamp,
  clipDurationMs,
  DEFAULT_PROJECT_NAME,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_CLIP_DURATION_MS,
  MIN_ZOOM,
  msToPx,
  pxToMs,
  formatRulerLabel,
  formatTransportTime,
  getTimelineDuration,
  toProjectDocument,
} from '../domain/model';
import type { EditorAsset, TimelineClip } from '../domain/model';
import {
  buildEditorAsset,
  hydrateProjectAsset,
  isSupportedMediaPath,
  loadProjectDocument,
  saveProjectDocument,
} from '../infrastructure/mediaApi';
import { createLogger, getErrorMessage, serializeError } from '../../../utils/logger';
import { openExportWindow } from '../../export/infrastructure/exportApi';
import { preparePendingExportSession } from '../../export/application/exportSession';
import { sortTracksInDisplayOrder } from '../domain/timelineCommands';
import {
  getPlaybackPreviewState,
  type PlaybackPreviewState,
  type PlaybackTimelineEntry,
  usePlaybackController,
} from '../application/usePlaybackController';
import styles from './MediaEditorWorkspace.module.css';

const log = createLogger('MediaEditorWorkspace');

const LABEL_WIDTH_PX = 188;

const RULER_STEP_CANDIDATES_MS = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
const MIN_TIMELINE_PADDING_MS = 60000;

type SourceDragState = {
  assetId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  hasMoved: boolean;
};

type ClipInteraction =
  | {
      type: 'move';
      clipId: string;
      startClientX: number;
      previewStartMs: number;
      previewTrackId: string;
      originStartMs: number;
    }
  | {
      type: 'trim-start';
      clipId: string;
      startClientX: number;
      previewInPointMs: number;
      originInPointMs: number;
    }
  | {
      type: 'trim-end';
      clipId: string;
      startClientX: number;
      previewOutPointMs: number;
      originOutPointMs: number;
    };

function projectNameFromPath(path: string) {
  return basename(path)
    .replace(/\.medproj(\.json)?$/i, '')
    .replace(/\.json$/i, '') || DEFAULT_PROJECT_NAME;
}

function rulerStepForZoom(zoom: number) {
  return (
    RULER_STEP_CANDIDATES_MS.find((stepMs) => msToPx(stepMs, zoom) >= 92)
    ?? RULER_STEP_CANDIDATES_MS.at(-1)
    ?? 1000
  );
}

export const MediaEditorWorkspace: React.FC = () => {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [projectFeedback, setProjectFeedback] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [, setIsImporting] = useState(false);
  const [, setIsProjectLoading] = useState(false);
  const [isExternalDropActive, setIsExternalDropActive] = useState(false);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [sourceDrag, setSourceDrag] = useState<SourceDragState | null>(null);
  const [interaction, setInteraction] = useState<ClipInteraction | null>(null);

  const sourceDragRef = useRef<SourceDragState | null>(null);
  const zoomWasManuallyAdjustedRef = useRef(false);
  const zoomRef = useRef(state.zoom);
  const pendingZoomAnchorRef = useRef<{ anchorMs: number; viewportX: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineCanvasRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const currentTimecodeRef = useRef<HTMLSpanElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const livePlayheadMsRef = useRef(state.playheadMs);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [livePreviewState, setLivePreviewState] = useState<PlaybackPreviewState>({
    previewAsset: null,
    hasActiveVideo: false,
  });

  const sortedTracks = useMemo(() => sortTracksInDisplayOrder(state.tracks), [state.tracks]);
  const assetMap = useMemo(() => new Map(state.assets.map((asset) => [asset.id, asset])), [state.assets]);
  const timelineDurationMs = useMemo(() => getTimelineDuration(state.clips), [state.clips]);
  const timelineVisibleWidthPx = useMemo(
    () => Math.max(240, timelineViewportWidth - LABEL_WIDTH_PX - 20),
    [timelineViewportWidth],
  );
  const visibleDurationMs = useMemo(
    () => pxToMs(timelineVisibleWidthPx, state.zoom),
    [state.zoom, timelineVisibleWidthPx],
  );
  const timelinePaddingMs = useMemo(
    () => Math.max(MIN_TIMELINE_PADDING_MS, visibleDurationMs * 2),
    [visibleDurationMs],
  );
  const timelineRangeEndMs = useMemo(() => {
    const visibleEndMs = pxToMs(timelineScrollLeft + timelineVisibleWidthPx, state.zoom);
    return Math.max(
      visibleDurationMs,
      timelineDurationMs + timelinePaddingMs,
      state.playheadMs + timelinePaddingMs,
      visibleEndMs + timelinePaddingMs,
    );
  }, [state.playheadMs, state.zoom, timelineDurationMs, timelinePaddingMs, timelineScrollLeft, timelineVisibleWidthPx, visibleDurationMs]);
  const timelineWidthPx = useMemo(() => {
    return Math.max(timelineVisibleWidthPx, Math.round(msToPx(timelineRangeEndMs, state.zoom) + 120));
  }, [state.zoom, timelineRangeEndMs, timelineVisibleWidthPx]);
  const fitZoom = useMemo(() => {
    if (timelineDurationMs <= 0 || timelineViewportWidth <= 0) {
      return state.zoom;
    }

    const usableWidth = Math.max(240, timelineVisibleWidthPx - 12);
    return clamp((usableWidth / timelineDurationMs) * 1000, MIN_ZOOM, MAX_ZOOM);
  }, [state.zoom, timelineDurationMs, timelineViewportWidth, timelineVisibleWidthPx]);
  const selectedClip = useMemo(
    () => state.clips.find((clip) => clip.id === state.selectedClipIds[0]) ?? null,
    [state.clips, state.selectedClipIds],
  );
  const trackOrderById = useMemo(
    () => new Map(state.tracks.map((track) => [track.id, track.order])),
    [state.tracks],
  );
  const playbackEntries = useMemo(() => {
    return state.clips
      .map((clip) => {
        const asset = assetMap.get(clip.assetId);
        if (!asset?.url) {
          return null;
        }

        return {
          clip,
          asset,
          trackOrder: trackOrderById.get(clip.trackId) ?? 0,
        } satisfies PlaybackTimelineEntry;
      })
      .filter((entry): entry is PlaybackTimelineEntry => Boolean(entry));
  }, [assetMap, state.clips, trackOrderById]);
  const mountedAudioEntries = useMemo(() => {
    return playbackEntries.filter((entry) => entry.asset.hasAudio);
  }, [playbackEntries]);
  const missingAssets = useMemo(
    () => state.assets.filter((asset) => asset.status === 'missing'),
    [state.assets],
  );
  const committedPreviewState = useMemo(
    () => getPlaybackPreviewState(playbackEntries, state.playheadMs),
    [playbackEntries, state.playheadMs],
  );
  const previewState = state.isPlaying ? livePreviewState : committedPreviewState;

  const applyLiveTransportFrame = useCallback((playheadMs: number) => {
    livePlayheadMsRef.current = playheadMs;

    if (currentTimecodeRef.current) {
      currentTimecodeRef.current.textContent = formatTransportTime(playheadMs);
    }

    if (timelineCanvasRef.current) {
      timelineCanvasRef.current.style.setProperty('--playhead-left', `${msToPx(playheadMs, zoomRef.current)}px`);
    }
  }, []);

  const handlePreviewChange = useCallback((nextPreviewState: PlaybackPreviewState) => {
    setLivePreviewState((currentPreviewState) => {
      if (
        currentPreviewState.hasActiveVideo === nextPreviewState.hasActiveVideo
        && currentPreviewState.previewAsset?.id === nextPreviewState.previewAsset?.id
      ) {
        return currentPreviewState;
      }

      return nextPreviewState;
    });
  }, []);

  const { togglePlay, seekBy, seekTo, stopPlayback } = usePlaybackController({
    isPlaying: state.isPlaying,
    playheadMs: state.playheadMs,
    timelineDurationMs,
    previewVolume: state.previewVolume,
    previewMuted: state.previewMuted,
    playbackEntries,
    videoRef: previewVideoRef,
    audioRefs,
    dispatch,
    onTransportFrame: applyLiveTransportFrame,
    onPreviewChange: handlePreviewChange,
  });

  useEffect(() => {
    sourceDragRef.current = sourceDrag;
  }, [sourceDrag]);

  useEffect(() => {
    zoomRef.current = state.zoom;
  }, [state.zoom]);

  useEffect(() => {
    applyLiveTransportFrame(livePlayheadMsRef.current);
  }, [applyLiveTransportFrame, state.zoom, timelineWidthPx]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return undefined;
    }

    let frameId = 0;
    const updateMetrics = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        setTimelineViewportWidth(scroller.clientWidth);
        setTimelineScrollLeft(scroller.scrollLeft);
      });
    };

    updateMetrics();

    const observer = new ResizeObserver(updateMetrics);
    observer.observe(scroller);
    scroller.addEventListener('scroll', updateMetrics, { passive: true });

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      scroller.removeEventListener('scroll', updateMetrics);
    };
  }, []);

  const handleTimelineWheelZoom = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey) {
      return;
    }

    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    event.preventDefault();
    zoomWasManuallyAdjustedRef.current = true;

    const bounds = scroller.getBoundingClientRect();
    const cursorX = clamp(event.clientX - bounds.left - LABEL_WIDTH_PX, 0, timelineVisibleWidthPx);
    const currentZoom = zoomRef.current;
    const cursorTimelineX = Math.max(0, scroller.scrollLeft + cursorX);
    const anchorMs = pxToMs(cursorTimelineX, currentZoom);
    const nextZoom = clamp(currentZoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);

    if (Math.abs(nextZoom - currentZoom) < 0.001) {
      return;
    }

    zoomRef.current = nextZoom;
    pendingZoomAnchorRef.current = { anchorMs, viewportX: cursorX };
    dispatch({ type: 'set-zoom', zoom: nextZoom });
  }, [dispatch, timelineVisibleWidthPx]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return undefined;
    }

    const onWheel = (event: WheelEvent) => handleTimelineWheelZoom(event);
    scroller.addEventListener('wheel', onWheel, { passive: false });

    return () => scroller.removeEventListener('wheel', onWheel);
  }, [handleTimelineWheelZoom]);

  useLayoutEffect(() => {
    const pendingAnchor = pendingZoomAnchorRef.current;
    const scroller = scrollRef.current;
    if (!pendingAnchor || !scroller) {
      return;
    }

    scroller.scrollLeft = Math.max(0, msToPx(pendingAnchor.anchorMs, state.zoom) - pendingAnchor.viewportX);
    setTimelineScrollLeft(scroller.scrollLeft);
    pendingZoomAnchorRef.current = null;
  }, [state.zoom, timelineWidthPx]);

  useEffect(() => {
    if (state.clips.length === 0) {
      zoomWasManuallyAdjustedRef.current = false;
      return;
    }

    if (zoomWasManuallyAdjustedRef.current || timelineViewportWidth <= 0) {
      return;
    }

    const nextZoom = Math.min(DEFAULT_ZOOM, fitZoom);
    if (state.zoom > nextZoom + 0.001) {
      dispatch({ type: 'set-zoom', zoom: nextZoom });
    }
  }, [fitZoom, state.clips.length, state.zoom, timelineViewportWidth]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const targetTagName = (event.target as HTMLElement | null)?.tagName;
      if (targetTagName === 'INPUT' || targetTagName === 'TEXTAREA') {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        dispatch({ type: 'delete-selected-clips' });
      }

      if (event.key.toLowerCase() === 's' && selectedClip) {
        dispatch({ type: 'split-clip', clipId: selectedClip.id, atMs: livePlayheadMsRef.current });
      }

      if (event.key.toLowerCase() === 'm' && selectedClip) {
        dispatch({ type: 'set-selected-clips-muted', muted: !selectedClip.muted });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClip, togglePlay]);

  useEffect(() => {
    if (!sourceDrag) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const current = sourceDragRef.current;
      if (!current || current.pointerId !== event.pointerId) {
        return;
      }

      setSourceDrag({
        ...current,
        clientX: event.clientX,
        clientY: event.clientY,
        hasMoved:
          current.hasMoved
          || Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY) > 6,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const current = sourceDragRef.current;
      if (!current || current.pointerId !== event.pointerId) {
        return;
      }

      if (current.hasMoved && scrollRef.current) {
        const lane = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-track-lane-id]');
        const trackId = lane?.dataset.trackLaneId;
        if (lane && trackId) {
          const bounds = lane.getBoundingClientRect();
          const localX = event.clientX - bounds.left + scrollRef.current.scrollLeft;
          dispatch({
            type: 'insert-clip',
            assetId: current.assetId,
            trackId,
            startMs: pxToMs(localX, state.zoom),
          });
        }
      }

      setSourceDrag(null);
    };

    const cancelDrag = () => setSourceDrag(null);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', cancelDrag);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', cancelDrag);
    };
  }, [sourceDrag, state.zoom]);

  useEffect(() => {
    if (!interaction) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (interaction.type === 'move') {
        const nextTrackId = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-track-lane-id]')
          ?.dataset.trackLaneId;
        const deltaMs = pxToMs(event.clientX - interaction.startClientX, state.zoom);
        setInteraction({
          ...interaction,
          previewStartMs: Math.max(0, interaction.originStartMs + deltaMs),
          previewTrackId: nextTrackId ?? interaction.previewTrackId,
        });
        return;
      }

      if (interaction.type === 'trim-start') {
        const clip = state.clips.find((candidate) => candidate.id === interaction.clipId);
        if (!clip) {
          return;
        }

        const deltaMs = pxToMs(event.clientX - interaction.startClientX, state.zoom);
        setInteraction({
          ...interaction,
          previewInPointMs: clamp(
            interaction.originInPointMs + deltaMs,
            0,
            clip.outPointMs - MIN_CLIP_DURATION_MS,
          ),
        });
        return;
      }

      if (interaction.type === 'trim-end') {
        const clip = state.clips.find((candidate) => candidate.id === interaction.clipId);
        const asset = clip ? assetMap.get(clip.assetId) : null;
        if (!clip || !asset) {
          return;
        }

        const deltaMs = pxToMs(event.clientX - interaction.startClientX, state.zoom);
        setInteraction({
          ...interaction,
          previewOutPointMs: clamp(
            interaction.originOutPointMs + deltaMs,
            clip.inPointMs + MIN_CLIP_DURATION_MS,
            asset.durationMs,
          ),
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

      setInteraction(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [assetMap, interaction, state.clips, state.zoom]);

  const importMediaPaths = useCallback(async (paths: string[]) => {
    const filtered = [...new Set(paths)].filter(isSupportedMediaPath);
    if (filtered.length === 0) {
      setImportFeedback('No supported video or audio files were selected.');
      return;
    }

    setIsImporting(true);
    setImportFeedback(null);

    try {
      const results = await Promise.allSettled(filtered.map((path) => buildEditorAsset(path)));
      const assets = results
        .filter((result): result is PromiseFulfilledResult<EditorAsset> => result.status === 'fulfilled')
        .map((result) => result.value);
      const failures = results.filter((result) => result.status === 'rejected');

      if (assets.length > 0) {
        dispatch({ type: 'add-assets', assets });
      }

      if (failures.length > 0) {
        setImportFeedback(
          failures[0].reason instanceof Error
            ? failures[0].reason.message
            : `${failures.length} file(s) failed to import.`,
        );
      }
    } catch (error) {
      setImportFeedback(error instanceof Error ? error.message : 'Failed to import media.');
    } finally {
      setIsImporting(false);
    }
  }, [dispatch]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setIsExternalDropActive(true);
          return;
        }

        if (event.payload.type === 'leave') {
          setIsExternalDropActive(false);
          return;
        }

        setIsExternalDropActive(false);
        void importMediaPaths(event.payload.paths);
      })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }

        unlisten = cleanup;
      })
      .catch(() => {
        /* keep dialog import available even if drag-drop registration fails */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importMediaPaths]);

  const ensureCanDiscard = () => {
    if (!state.dirty) {
      return true;
    }

    return window.confirm('There are unsaved changes. Discard them?');
  };

  const loadProjectFromPath = async (path: string) => {
    setIsProjectLoading(true);
    setProjectFeedback(null);

    try {
      const document = await loadProjectDocument(path);
      const hydratedAssets = await Promise.all(document.assets.map((asset) => hydrateProjectAsset(asset)));

      const nextState = {
        ...buildDefaultProjectState(),
        documentPath: path,
        documentName: document.name?.trim() || projectNameFromPath(path),
        assets: hydratedAssets,
        tracks: document.tracks.length > 0 ? document.tracks : buildDefaultProjectState().tracks,
        clips: document.clips,
        renderProfile: document.renderProfile ?? buildDefaultProjectState().renderProfile,
      };

      zoomWasManuallyAdjustedRef.current = true;
      dispatch({ type: 'replace-project', nextState });
    } catch (error) {
      log.error('Failed to open project.', {
        path,
        error: serializeError(error),
      });
      setProjectFeedback(getErrorMessage(error, 'Failed to open project.'));
    } finally {
      setIsProjectLoading(false);
    }
  };

  const handleImportClick = async () => {
    const selection = await open({
      multiple: true,
      title: 'Import media files',
      filters: [
        {
          name: 'Media',
          extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
        },
      ],
    });

    if (!selection) {
      return;
    }

    await importMediaPaths(Array.isArray(selection) ? selection : [selection]);
  };

  const handleOpenProject = async () => {
    if (!ensureCanDiscard()) {
      return;
    }

    const selection = await open({
      multiple: false,
      title: 'Open project',
      filters: [{ name: 'Media Editor Project', extensions: ['medproj', 'json'] }],
    });
    if (!selection || Array.isArray(selection)) {
      return;
    }

    await loadProjectFromPath(selection);
  };

  const handleSaveProject = async (saveAs = false) => {
    try {
      let documentPath = saveAs ? null : state.documentPath;
      if (!documentPath) {
        const selectedPath = await save({
          title: saveAs || !state.documentPath ? 'Save project as' : 'Save project',
          defaultPath: `${state.documentName || DEFAULT_PROJECT_NAME}.medproj.json`,
          filters: [{ name: 'Media Editor Project', extensions: ['medproj', 'json'] }],
        });
        if (!selectedPath) {
          return;
        }

        documentPath = selectedPath;
      }

      const nextDocument = toProjectDocument({
        ...state,
        playheadMs: livePlayheadMsRef.current,
      });
      nextDocument.name = projectNameFromPath(documentPath);
      await saveProjectDocument(documentPath, nextDocument);
      dispatch({
        type: 'mark-saved',
        documentPath,
        documentName: projectNameFromPath(documentPath),
      });
      setProjectFeedback(null);
    } catch (error) {
      log.error('Failed to save project.', {
        path: state.documentPath,
        error: serializeError(error),
      });
      setProjectFeedback(getErrorMessage(error, 'Failed to save project.'));
    }
  };

  const handleNewProject = () => {
    if (!ensureCanDiscard()) {
      return;
    }

    stopPlayback();
    zoomWasManuallyAdjustedRef.current = false;
    dispatch({ type: 'reset-project' });
    setProjectFeedback(null);
    setImportFeedback(null);
  };

  const handleOpenExportWindow = async () => {
    stopPlayback();
    setProjectFeedback(null);

    try {
      const snapshot = preparePendingExportSession(state);
      await openExportWindow(snapshot);
    } catch (error) {
      log.error('Failed to open export window.', {
        error: serializeError(error),
        timeline: {
          clips: state.clips.length,
          tracks: state.tracks.length,
          assets: state.assets.length,
        },
      });
      setProjectFeedback(getErrorMessage(error, 'Failed to open export window.'));
    }
  };

  const handleRelinkAsset = async (assetId: string) => {
    const selection = await open({
      multiple: false,
      title: 'Relink media file',
      filters: [
        {
          name: 'Media',
          extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
        },
      ],
    });

    if (!selection || Array.isArray(selection)) {
      return;
    }

    try {
      const asset = await buildEditorAsset(selection);
      dispatch({ type: 'relink-asset', assetId, asset });
      setImportFeedback(null);
    } catch (error) {
      setImportFeedback(error instanceof Error ? error.message : 'Failed to relink media.');
    }
  };

  const handleTimelineSeek = (event: React.PointerEvent<HTMLElement>) => {
    if (!scrollRef.current) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left + scrollRef.current.scrollLeft;
    seekTo(pxToMs(localX, state.zoom), state.isPlaying);
  };

  const handleSourcePointerDown = (event: React.PointerEvent<HTMLButtonElement>, assetId: string) => {
    if (event.button !== 0) {
      return;
    }

    const asset = assetMap.get(assetId);
    if (!asset || asset.status !== 'ready') {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    setSourceDrag({
      assetId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      hasMoved: false,
    });
  };

  const handleClipPointerDown = (event: React.PointerEvent<HTMLDivElement>, clip: TimelineClip) => {
    event.stopPropagation();
    stopPlayback();
    dispatch({ type: 'set-selection', clipIds: [clip.id] });
    setInteraction({
      type: 'move',
      clipId: clip.id,
      startClientX: event.clientX,
      previewStartMs: clip.startMs,
      previewTrackId: clip.trackId,
      originStartMs: clip.startMs,
    });
  };

  const handleTrimStartPointerDown = (event: React.PointerEvent<HTMLButtonElement>, clip: TimelineClip) => {
    event.stopPropagation();
    stopPlayback();
    dispatch({ type: 'set-selection', clipIds: [clip.id] });
    setInteraction({
      type: 'trim-start',
      clipId: clip.id,
      startClientX: event.clientX,
      previewInPointMs: clip.inPointMs,
      originInPointMs: clip.inPointMs,
    });
  };

  const handleTrimEndPointerDown = (event: React.PointerEvent<HTMLButtonElement>, clip: TimelineClip) => {
    event.stopPropagation();
    stopPlayback();
    dispatch({ type: 'set-selection', clipIds: [clip.id] });
    setInteraction({
      type: 'trim-end',
      clipId: clip.id,
      startClientX: event.clientX,
      previewOutPointMs: clip.outPointMs,
      originOutPointMs: clip.outPointMs,
    });
  };

  const rulerStepMs = useMemo(() => rulerStepForZoom(state.zoom), [state.zoom]);
  const rulerTicks = useMemo(() => {
    const paddingPx = Math.max(timelineVisibleWidthPx, 240);
    const visibleStartMs = pxToMs(Math.max(0, timelineScrollLeft - paddingPx), state.zoom);
    const visibleEndMs = Math.min(
      timelineRangeEndMs + rulerStepMs,
      pxToMs(timelineScrollLeft + timelineVisibleWidthPx + paddingPx, state.zoom),
    );
    const startMs = Math.max(0, Math.floor(visibleStartMs / rulerStepMs) * rulerStepMs);
    const endMs = Math.ceil(visibleEndMs / rulerStepMs) * rulerStepMs;
    const ticks: number[] = [];
    for (let current = startMs; current <= endMs; current += rulerStepMs) {
      ticks.push(Math.round(current));
    }
    return ticks;
  }, [rulerStepMs, state.zoom, timelineRangeEndMs, timelineScrollLeft, timelineVisibleWidthPx]);

  const clipsByTrack = useMemo(() => {
    const map = new Map<string, Array<{ clip: TimelineClip; leftPx: number; widthPx: number }>>();

    for (const track of sortedTracks) {
      map.set(track.id, []);
    }

    for (const clip of state.clips) {
      const activeInteraction = interaction && interaction.clipId === clip.id ? interaction : null;
      const currentTrackId = activeInteraction?.type === 'move' ? activeInteraction.previewTrackId : clip.trackId;
      const currentStartMs = activeInteraction?.type === 'move'
        ? activeInteraction.previewStartMs
        : activeInteraction?.type === 'trim-start'
          ? clip.startMs + (activeInteraction.previewInPointMs - clip.inPointMs)
          : clip.startMs;
      const currentInPointMs = activeInteraction?.type === 'trim-start'
        ? activeInteraction.previewInPointMs
        : clip.inPointMs;
      const currentOutPointMs = activeInteraction?.type === 'trim-end'
        ? activeInteraction.previewOutPointMs
        : clip.outPointMs;

      map.get(currentTrackId)?.push({
        clip,
        leftPx: msToPx(currentStartMs, state.zoom),
        widthPx: Math.max(28, msToPx(currentOutPointMs - currentInPointMs, state.zoom)),
      });
    }

    return map;
  }, [interaction, sortedTracks, state.clips, state.zoom]);

  const draggedAsset = sourceDrag ? assetMap.get(sourceDrag.assetId) ?? null : null;

  return (
    <div className={styles.editor}>
      <section className={styles.toolbar}>
        <div className={styles.projectMeta}>
          <strong>{state.documentName}</strong>
          {state.dirty && <span className={styles.dirtyDot} />}
        </div>

        <div className={styles.toolbarActions}>
          <button type="button" className={styles.iconButton} onClick={handleNewProject}>
            <FilePlus2 size={14} />
          </button>
          <button type="button" className={styles.iconButton} onClick={() => void handleOpenProject()}>
            <FolderOpen size={14} />
          </button>
          <button type="button" className={styles.iconButton} onClick={() => void handleSaveProject(false)}>
            <Save size={14} />
          </button>
          <div className={styles.toolbarDivider} />
          <button type="button" className={styles.toolbarButton} onClick={() => void handleOpenExportWindow()}>
            <FileOutput size={14} />
            Export
          </button>
          <button type="button" className={styles.primaryButton} onClick={() => void handleImportClick()}>
            <Import size={14} />
            Import
          </button>
        </div>
      </section>

      {projectFeedback && (
        <section className={styles.noticeBar}>
          <div className={`${styles.notice} ${styles.noticeError}`}>
            <AlertCircle size={15} />
            <span>{projectFeedback}</span>
          </div>
        </section>
      )}

      <div className={styles.content}>
        <aside className={styles.binPanel}>
          {isExternalDropActive && (
            <div className={styles.dropOverlay}>
              <div className={styles.dropOverlayContent}>
                <Import size={32} />
                <strong>Drop Media Here</strong>
                <span>Release to import files into the project</span>
              </div>
            </div>
          )}
          <div className={styles.panelHeader}>
            <h2>Media Pool</h2>
            <span className={styles.badge}>{state.assets.length}</span>
          </div>

          {missingAssets.length > 0 && (
            <div className={styles.missingSummary}>
              <AlertCircle size={15} />
              <span>{missingAssets.length} file(s) missing. Relink them before playback/export.</span>
            </div>
          )}

          {importFeedback && (
            <div className={styles.missingSummary}>
              <AlertCircle size={15} />
              <span>{importFeedback}</span>
            </div>
          )}

          <div className={styles.assetList}>
            {state.assets.length === 0 && (
              <button type="button" className={styles.emptyState} onClick={() => void handleImportClick()}>
                <Import size={20} />
              </button>
            )}

            {state.assets.map((asset) => (
              <div key={asset.id} className={`${styles.assetCard} ${asset.status === 'missing' ? styles.assetCardMissing : ''}`}>
                <button
                  type="button"
                  className={styles.assetDragButton}
                  onPointerDown={(event) => handleSourcePointerDown(event, asset.id)}
                  onDoubleClick={() => {
                    if (asset.status !== 'ready' || sortedTracks.length === 0) {
                      return;
                    }
                    dispatch({
                      type: 'insert-clip',
                      assetId: asset.id,
                      trackId: sortedTracks[0].id,
                      startMs: livePlayheadMsRef.current,
                    });
                  }}
                  disabled={asset.status !== 'ready'}
                >
                  <div className={styles.assetVisual}>
                    {asset.thumbnailUrl ? (
                      <img src={asset.thumbnailUrl} alt={asset.name} />
                    ) : (
                      <div className={styles.assetFallback}>
                        {asset.kind === 'video' ? <Film size={16} /> : <Music2 size={16} />}
                      </div>
                    )}
                  </div>
                  <div className={styles.assetMeta}>
                    <strong>{asset.name}</strong>
                    <span>{formatTransportTime(asset.durationMs)}</span>
                    <span>{asset.status === 'missing' ? 'Missing file' : asset.kind}</span>
                  </div>
                </button>

                <div className={styles.assetActions}>
                  {asset.status === 'missing' ? (
                    <button type="button" className={styles.iconButton} onClick={() => void handleRelinkAsset(asset.id)}>
                      <Link2 size={14} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => dispatch({ type: 'remove-asset', assetId: asset.id })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main className={styles.mainPanel}>
          <section className={styles.previewPanel}>
            <div className={styles.previewContainer}>
              <video
                ref={previewVideoRef}
                className={`${styles.previewVideo} ${!previewState.hasActiveVideo ? styles.previewVideoHidden : ''}`}
                muted
                playsInline
                preload="auto"
              />
              {!previewState.hasActiveVideo && (
                <div className={styles.previewPlaceholder}>
                  {previewState.previewAsset?.kind === 'audio' ? <Music2 size={32} /> : <Film size={32} />}
                </div>
              )}

              <div className={styles.transportOverlay}>
                <div className={styles.transportTime}>
                  <span ref={currentTimecodeRef} className={styles.timecode}>{formatTransportTime(state.playheadMs)}</span>
                  <span className={styles.timecodeDivider}>/</span>
                  <span className={styles.timecodeDuration}>{formatTransportTime(timelineDurationMs)}</span>
                </div>

                <div className={styles.transportMainRow}>
                  <div className={styles.volumeGroup}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => dispatch({ type: 'set-preview-muted', previewMuted: !state.previewMuted })}
                    >
                      {state.previewMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={state.previewVolume}
                      onChange={(event) =>
                        dispatch({
                          type: 'set-preview-volume',
                          previewVolume: Number(event.target.value),
                        })}
                    />
                  </div>

                  <div className={styles.transportButtons}>
                    <button type="button" className={styles.iconButton} onClick={() => seekBy(-1000)} disabled={timelineDurationMs === 0}>
                      <SkipBack size={16} />
                    </button>
                    <button type="button" className={styles.transportPrimary} onClick={togglePlay} disabled={timelineDurationMs === 0}>
                      {state.isPlaying ? <Pause size={18} /> : <Play size={18} />}
                    </button>
                    <button type="button" className={styles.iconButton} onClick={() => seekBy(1000)} disabled={timelineDurationMs === 0}>
                      <SkipForward size={16} />
                    </button>
                  </div>
                  
                  <div className={styles.transportSpacer} />
                </div>
              </div>
            </div>
          </section>

          <section className={styles.timelinePanel}>
            <div className={styles.panelHeader}>
              <div className={styles.timelineActions}>
                <button type="button" className={styles.iconButton} onClick={() => dispatch({ type: 'split-clip', clipId: selectedClip?.id ?? '', atMs: livePlayheadMsRef.current })} disabled={!selectedClip}>
                  <Scissors size={14} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => dispatch({ type: 'set-selected-clips-muted', muted: !selectedClip?.muted })}
                  disabled={!selectedClip}
                  aria-label={selectedClip?.muted ? 'Unmute selected clip' : 'Mute selected clip'}
                  title={selectedClip?.muted ? 'Unmute selected clip' : 'Mute selected clip'}
                >
                  {selectedClip?.muted ? <Volume2 size={14} /> : <VolumeX size={14} />}
                </button>
                <button type="button" className={styles.iconButton} onClick={() => dispatch({ type: 'delete-selected-clips' })} disabled={!selectedClip}>
                  <Trash2 size={14} />
                </button>
                <div className={styles.toolbarDivider} />
                <button type="button" className={styles.toolbarButton} onClick={() => dispatch({ type: 'add-track' })}>
                  <Plus size={14} />
                  Track
                </button>
              </div>
            </div>

            <div className={styles.timelineScroller} ref={scrollRef}>
              <div
                ref={timelineCanvasRef}
                className={styles.timelineCanvas}
                style={{
                  width: `${LABEL_WIDTH_PX + timelineWidthPx}px`,
                  '--playhead-left': `${msToPx(state.playheadMs, state.zoom)}px`,
                } as React.CSSProperties}
              >
                <div className={styles.rulerRow}>
                  <div className={styles.stickyCell}>Tracks</div>
                  <button type="button" className={styles.rulerSurface} onPointerDown={handleTimelineSeek}>
                    {rulerTicks.map((tickMs) => (
                      <div key={tickMs} className={styles.rulerTick} style={{ left: `${msToPx(tickMs, state.zoom)}px` }}>
                        <span>{formatRulerLabel(tickMs)}</span>
                      </div>
                    ))}
                    <div className={styles.playhead} />
                  </button>
                </div>

                {sortedTracks.map((track) => (
                  <div key={track.id} className={styles.trackRow}>
                    <div className={styles.stickyCell}>
                      <div className={styles.trackLabelBlock}>
                        <strong>{track.name}</strong>
                        <span>{track.order}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.iconButton}
                        onClick={() => dispatch({ type: 'remove-track', trackId: track.id })}
                        disabled={state.tracks.length <= 1}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    <div
                      className={styles.trackLane}
                      data-track-lane-id={track.id}
                      onPointerDown={handleTimelineSeek}
                      style={{ '--grid-step': `${msToPx(rulerStepMs, state.zoom)}px` } as React.CSSProperties}
                    >
                      <div className={styles.playhead} />
                      {clipsByTrack.get(track.id)?.map(({ clip, leftPx, widthPx }) => {
                        const asset = assetMap.get(clip.assetId);
                        if (!asset) {
                          return null;
                        }

                        return (
                          <div
                            key={clip.id}
                            className={`${styles.clip} ${state.selectedClipIds.includes(clip.id) ? styles.clipSelected : ''} ${clip.muted ? styles.clipMuted : ''}`}
                            style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                            data-clip-id={clip.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={state.selectedClipIds.includes(clip.id)}
                            onPointerDown={(event) => handleClipPointerDown(event, clip)}
                          >
                            <button
                              type="button"
                              className={`${styles.trimHandle} ${styles.trimHandleStart}`}
                              onPointerDown={(event) => handleTrimStartPointerDown(event, clip)}
                            />
                            <div className={styles.clipBody}>
                              <span className={styles.clipIcon}>{asset.kind === 'video' ? <Film size={12} /> : <Music2 size={12} />}</span>
                              <span className={styles.clipText}>{asset.name}</span>
                              <span className={styles.clipDuration}>{formatTransportTime(clipDurationMs(clip))}</span>
                            </div>
                            <button
                              type="button"
                              className={`${styles.trimHandle} ${styles.trimHandleEnd}`}
                              onPointerDown={(event) => handleTrimEndPointerDown(event, clip)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>

      {mountedAudioEntries.map(({ clip, asset }) => (
        <audio
          key={clip.id}
          ref={(element) => {
            if (element) {
              audioRefs.current.set(clip.id, element);
              return;
            }
            audioRefs.current.delete(clip.id);
          }}
          src={asset.url ?? undefined}
          preload="auto"
          className={styles.hiddenMedia}
        />
      ))}

      {sourceDrag?.hasMoved && draggedAsset && (
        <div
          className={styles.dragGhost}
          style={{
            left: `${sourceDrag.clientX - sourceDrag.offsetX}px`,
            top: `${sourceDrag.clientY - sourceDrag.offsetY}px`,
          }}
        >
          {draggedAsset.kind === 'video' ? <Film size={15} /> : <Music2 size={15} />}
          <span>{draggedAsset.name}</span>
        </div>
      )}
    </div>
  );
};