import type {
  RenderProfile,
  TimelineClip,
  TimelineTrack,
} from './editor';

export type { AudioBitrateKbps, ExportFormat, RenderProfile, VideoQuality } from './editor';

export interface ExportSource {
  id: string;
  name: string;
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export type ExportTrack = Pick<TimelineTrack, 'id' | 'name' | 'order'>;

export type ExportClip = Pick<
  TimelineClip,
  'id' | 'assetId' | 'trackId' | 'startMs' | 'inPointMs' | 'outPointMs' | 'muted'
>;

export interface ExportSnapshot {
  projectName: string;
  suggestedName: string;
  timelineDurationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  dominantWidth?: number;
  dominantHeight?: number;
  sources: ExportSource[];
  tracks: ExportTrack[];
  clips: ExportClip[];
  renderProfile: RenderProfile;
}

export interface TimelineExportRequest {
  outputPath: string;
  profile: RenderProfile;
  snapshot: ExportSnapshot;
}

export interface ExportProgressPayload {
  progress: number;
  stage: string;
  detail: string;
  done: boolean;
  failed: boolean;
}