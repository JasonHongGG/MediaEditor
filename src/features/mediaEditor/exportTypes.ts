import type { TimelineClip, TimelineTrack } from './model';

export type ExportFormat = 'mp4' | 'mkv' | 'mp3' | 'm4a' | 'wav';

export type VideoQuality = 'source' | '2160p' | '1440p' | '1080p' | '720p' | '480p';

export type AudioBitrateKbps = 320 | 256 | 192 | 128 | 96;

export interface ExportSource {
  id: string;
  name: string;
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export interface ExportTrack extends Pick<TimelineTrack, 'id' | 'name' | 'order'> {}

export interface ExportClip extends Pick<
  TimelineClip,
  'id' | 'assetId' | 'trackId' | 'startMs' | 'inPointMs' | 'outPointMs' | 'muted'
> {}

export interface PendingExportSession {
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
}

export interface TimelineExportRequest {
  outputPath: string;
  format: ExportFormat;
  videoQuality?: VideoQuality;
  audioBitrateKbps?: AudioBitrateKbps;
  session: PendingExportSession;
}

export interface ExportProgressPayload {
  progress: number;
  stage: string;
  detail: string;
  done: boolean;
  failed: boolean;
}