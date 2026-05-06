import type {
  MediaProbeResult,
  ProjectAssetRecord,
  ProjectDocumentV2,
  RenderProfile,
  TimelineClip,
  TimelineTrack,
  WorkspaceSession,
} from '../../../shared/contracts';

export type {
  MediaProbeResult,
  ProjectAssetRecord,
  ProjectDocumentV2,
  RenderProfile,
  TimelineClip,
  TimelineTrack,
  WorkspaceSession,
} from '../../../shared/contracts';

export type AssetStatus = 'ready' | 'missing';

export interface EditorAsset extends ProjectAssetRecord {
  status: AssetStatus;
  url: string | null;
  thumbnailUrl: string | null;
}

export interface EditorProjectState {
  documentPath: string | null;
  documentName: string;
  dirty: boolean;
  assets: EditorAsset[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  renderProfile: RenderProfile;
  selectedClipIds: string[];
  playheadMs: number;
  zoom: number;
  previewVolume: number;
  previewMuted: boolean;
  isPlaying: boolean;
}

export const DEFAULT_TRACKS: TimelineTrack[] = [
  { id: 'track-1', name: 'Track 1', order: 1 },
  { id: 'track-2', name: 'Track 2', order: 2 },
  { id: 'track-3', name: 'Track 3', order: 3 },
];

export const DEFAULT_PROJECT_NAME = 'Untitled Project';

export const DEFAULT_RENDER_PROFILE: RenderProfile = {
  format: 'mp4',
  fps: 60,
  videoQuality: '1080p',
  audioBitrateKbps: 320,
};

export const DEFAULT_ZOOM = 96;

export const MIN_ZOOM = 0.5;

export const MAX_ZOOM = 2400;

export const MIN_CLIP_DURATION_MS = 120;

export const TRACK_HEIGHT = 72;

export function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
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
  return dotIndex === -1 ? '' : fileName.slice(dotIndex + 1).toLowerCase();
}

export function detectMediaKind(path: string, probe?: Pick<MediaProbeResult, 'hasVideo'>) {
  if (probe?.hasVideo) {
    return 'video';
  }

  const extension = extensionOf(path);
  if (['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'].includes(extension)) {
    return 'video';
  }

  return 'audio';
}

export function clipDurationMs(clip: TimelineClip) {
  return Math.max(0, clip.outPointMs - clip.inPointMs);
}

export function clipEndMs(clip: TimelineClip) {
  return clip.startMs + clipDurationMs(clip);
}

export function msToPx(milliseconds: number, zoom: number) {
  return (milliseconds / 1000) * zoom;
}

export function pxToMs(pixels: number, zoom: number) {
  return (pixels / zoom) * 1000;
}

export function formatTransportTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatRulerLabel(milliseconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(milliseconds));
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const millisecondsPart = totalMilliseconds % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const baseLabel = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;

  if (millisecondsPart === 0) {
    return baseLabel;
  }

  return `${baseLabel}.${millisecondsPart.toString().padStart(3, '0')}`;
}

export function getTimelineDuration(clips: TimelineClip[]) {
  if (clips.length === 0) {
    return 0;
  }

  return clips.reduce((maxValue, clip) => Math.max(maxValue, clipEndMs(clip)), 0);
}

export function createWorkspaceSession(): WorkspaceSession {
  return {
    playheadMs: 0,
    zoom: DEFAULT_ZOOM,
    previewVolume: 0.85,
    previewMuted: false,
  };
}

export function workspaceSessionFromState(state: Pick<EditorProjectState, 'playheadMs' | 'zoom' | 'previewVolume' | 'previewMuted'>): WorkspaceSession {
  return {
    playheadMs: state.playheadMs,
    zoom: state.zoom,
    previewVolume: state.previewVolume,
    previewMuted: state.previewMuted,
  };
}

export function buildDefaultProjectState(): EditorProjectState {
  const session = createWorkspaceSession();

  return {
    documentPath: null,
    documentName: DEFAULT_PROJECT_NAME,
    dirty: false,
    assets: [],
    tracks: [...DEFAULT_TRACKS],
    clips: [],
    renderProfile: { ...DEFAULT_RENDER_PROFILE },
    selectedClipIds: [],
    playheadMs: session.playheadMs,
    zoom: session.zoom,
    previewVolume: session.previewVolume,
    previewMuted: session.previewMuted,
    isPlaying: false,
  };
}

export function toProjectDocument(state: EditorProjectState): ProjectDocumentV2 {
  return {
    version: 2,
    name: state.documentName,
    savedAt: new Date().toISOString(),
    assets: state.assets.map(({ id, name, path, kind, durationMs, hasVideo, hasAudio, width, height }) => ({
      id,
      name,
      path,
      kind,
      durationMs,
      hasVideo,
      hasAudio,
      width,
      height,
    })),
    tracks: state.tracks,
    clips: state.clips,
    renderProfile: { ...state.renderProfile },
  };
}