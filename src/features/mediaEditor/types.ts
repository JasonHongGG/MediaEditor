export type MediaKind = 'video' | 'audio';

export type TrackKind = 'video' | 'audio';

export type EditorTool = 'select' | 'split' | 'mute';

export interface MutedRange {
  id: string;
  startMs: number;
  endMs: number;
}

export interface MediaSource {
  id: string;
  name: string;
  path: string;
  url: string;
  kind: MediaKind;
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  accent: string;
}

export interface MediaProbeResult {
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  order: number;
}

export interface TimelineClip {
  id: string;
  sourceId: string;
  trackId: string;
  startMs: number;
  inPointMs: number;
  outPointMs: number;
  mutedRanges: MutedRange[];
}

export interface MediaEditorState {
  sources: MediaSource[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  selectedClipIds: string[];
  playheadMs: number;
  zoom: number;
  isPlaying: boolean;
  activeTool: EditorTool;
  previewVolume: number;
  previewMuted: boolean;
}

export interface PendingExportSession {
  sources: MediaSource[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  timelineDurationMs: number;
  suggestedName: string;
  dominantWidth?: number;
  dominantHeight?: number;
}

export interface ExportProgressPayload {
  progress: number;
  stage: string;
  detail: string;
  done: boolean;
  failed: boolean;
}