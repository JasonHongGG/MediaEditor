import type { EditorProjectState } from './model';
import { getTimelineDuration } from './model';
import type { PendingExportSession } from './exportTypes';

function sanitizeSuggestedName(name: string) {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'timeline-export';
}

export function preparePendingExportSession(state: EditorProjectState): PendingExportSession {
  if (state.clips.length === 0) {
    throw new Error('Add at least one clip to the timeline before exporting.');
  }

  const usedAssetIds = new Set(state.clips.map((clip) => clip.assetId));
  const usedAssets = state.assets.filter((asset) => usedAssetIds.has(asset.id));
  const missingAssets = usedAssets.filter((asset) => asset.status !== 'ready' || !asset.path);
  if (missingAssets.length > 0) {
    throw new Error(`Relink missing media before exporting: ${missingAssets[0].name}`);
  }

  const dominantVideoAsset = usedAssets
    .filter((asset) => asset.hasVideo && asset.width && asset.height)
    .sort(
      (left, right) =>
        ((right.width ?? 0) * (right.height ?? 0)) - ((left.width ?? 0) * (left.height ?? 0)),
    )[0] ?? null;

  return {
    projectName: state.documentName,
    suggestedName: sanitizeSuggestedName(state.documentName),
    timelineDurationMs: getTimelineDuration(state.clips),
    hasVideo: usedAssets.some((asset) => asset.hasVideo),
    hasAudio: usedAssets.some((asset) => asset.hasAudio),
    dominantWidth: dominantVideoAsset?.width,
    dominantHeight: dominantVideoAsset?.height,
    sources: usedAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      path: asset.path,
      hasVideo: asset.hasVideo,
      hasAudio: asset.hasAudio,
      width: asset.width,
      height: asset.height,
    })),
    tracks: state.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      order: track.order,
    })),
    clips: state.clips.map((clip) => ({
      id: clip.id,
      assetId: clip.assetId,
      trackId: clip.trackId,
      startMs: clip.startMs,
      inPointMs: clip.inPointMs,
      outPointMs: clip.outPointMs,
      muted: clip.muted,
    })),
  };
}