import {
  buildDefaultProjectState,
  clipDurationMs,
  clipEndMs,
  createId,
  MIN_CLIP_DURATION_MS,
} from './model';
import type { EditorProjectState, TimelineClip, TimelineTrack } from './model';

const SNAP_THRESHOLD_MS = 120;

function sortByStart(clips: TimelineClip[]) {
  return [...clips].sort((left, right) => {
    if (left.startMs !== right.startMs) {
      return left.startMs - right.startMs;
    }

    return left.id.localeCompare(right.id);
  });
}

function getTrackClips(
  clips: TimelineClip[],
  trackId: string,
  excludeClipId?: string,
) {
  return sortByStart(
    clips.filter((clip) => clip.trackId === trackId && clip.id !== excludeClipId),
  );
}

function findTrackInsertionStart(
  clips: TimelineClip[],
  trackId: string,
  durationMs: number,
  proposedStartMs: number,
  excludeClipId?: string,
) {
  const trackClips = getTrackClips(clips, trackId, excludeClipId);
  const candidates: Array<{ startMs: number; distance: number }> = [];
  let previousEndMs = 0;

  for (const clip of trackClips) {
    const validMin = previousEndMs;
    const validMax = clip.startMs - durationMs;

    if (validMax >= validMin) {
      const clamped = Math.min(validMax, Math.max(validMin, proposedStartMs));
      candidates.push({
        startMs: clamped,
        distance: Math.abs(clamped - proposedStartMs),
      });
    }

    previousEndMs = clipEndMs(clip);
  }

  const tailStartMs = Math.max(previousEndMs, proposedStartMs);
  candidates.push({
    startMs: tailStartMs,
    distance: Math.abs(tailStartMs - proposedStartMs),
  });

  return candidates.sort((left, right) => left.distance - right.distance)[0]?.startMs ?? 0;
}

function findClip(state: EditorProjectState, clipId: string) {
  return state.clips.find((clip) => clip.id === clipId) ?? null;
}

function findClipAsset(state: EditorProjectState, clip: TimelineClip) {
  return state.assets.find((asset) => asset.id === clip.assetId) ?? null;
}

function snapValue(valueMs: number, snapPointsMs: number[]) {
  let closest = valueMs;
  let closestDistance = SNAP_THRESHOLD_MS + 1;

  for (const pointMs of snapPointsMs) {
    if (!Number.isFinite(pointMs) || pointMs < 0) {
      continue;
    }

    const distance = Math.abs(pointMs - valueMs);
    if (distance < closestDistance) {
      closest = pointMs;
      closestDistance = distance;
    }
  }

  return closestDistance <= SNAP_THRESHOLD_MS ? closest : valueMs;
}

function trackBoundaryPoints(state: EditorProjectState, trackId: string, excludeClipId?: string) {
  const boundaries = [0, state.playheadMs];

  for (const clip of getTrackClips(state.clips, trackId, excludeClipId)) {
    boundaries.push(clip.startMs, clipEndMs(clip));
  }

  return boundaries;
}

function trackMoveSnapPoints(
  state: EditorProjectState,
  trackId: string,
  durationMs: number,
  excludeClipId?: string,
) {
  const boundaries = trackBoundaryPoints(state, trackId, excludeClipId);
  const snapPoints = [...boundaries];

  for (const boundary of boundaries) {
    snapPoints.push(boundary - durationMs);
  }

  return snapPoints;
}

function withClips(
  state: EditorProjectState,
  clips: TimelineClip[],
  selectedClipIds = state.selectedClipIds,
) {
  return {
    ...state,
    clips,
    selectedClipIds,
    dirty: true,
    isPlaying: false,
  };
}

function previousClip(state: EditorProjectState, clip: TimelineClip) {
  return getTrackClips(state.clips, clip.trackId, clip.id)
    .filter((candidate) => candidate.startMs < clip.startMs)
    .at(-1) ?? null;
}

function nextClip(state: EditorProjectState, clip: TimelineClip) {
  return getTrackClips(state.clips, clip.trackId, clip.id)
    .find((candidate) => candidate.startMs >= clip.startMs) ?? null;
}

export function replaceProjectState(_state: EditorProjectState, nextState: EditorProjectState) {
  return {
    ...nextState,
    isPlaying: false,
    dirty: false,
    selectedClipIds: [],
  };
}

export function resetProjectState() {
  return buildDefaultProjectState();
}

export function insertClip(
  state: EditorProjectState,
  assetId: string,
  trackId: string,
  startMs: number,
) {
  const asset = state.assets.find((candidate) => candidate.id === assetId && candidate.status === 'ready');
  if (!asset) {
    return state;
  }

  const durationMs = Math.max(MIN_CLIP_DURATION_MS, asset.durationMs);
  const snappedStartMs = snapValue(
    Math.max(0, startMs),
    trackMoveSnapPoints(state, trackId, durationMs),
  );
  const resolvedStartMs = findTrackInsertionStart(
    state.clips,
    trackId,
    durationMs,
    snappedStartMs,
  );

  const nextClip: TimelineClip = {
    id: createId('clip'),
    assetId,
    trackId,
    startMs: resolvedStartMs,
    inPointMs: 0,
    outPointMs: durationMs,
    muted: false,
  };

  return withClips(state, [...state.clips, nextClip], [nextClip.id]);
}

export function moveClip(
  state: EditorProjectState,
  clipId: string,
  trackId: string,
  startMs: number,
) {
  const clip = findClip(state, clipId);
  if (!clip) {
    return state;
  }

  const snappedStartMs = snapValue(
    Math.max(0, startMs),
    trackMoveSnapPoints(state, trackId, clipDurationMs(clip), clip.id),
  );
  const resolvedStartMs = findTrackInsertionStart(
    state.clips,
    trackId,
    clipDurationMs(clip),
    snappedStartMs,
    clip.id,
  );

  return withClips(
    state,
    state.clips.map((candidate) =>
      candidate.id === clipId
        ? { ...candidate, trackId, startMs: resolvedStartMs }
        : candidate,
    ),
  );
}

export function trimClipStart(
  state: EditorProjectState,
  clipId: string,
  proposedInPointMs: number,
) {
  const clip = findClip(state, clipId);
  if (!clip) {
    return state;
  }

  let nextInPointMs = Math.min(
    clip.outPointMs - MIN_CLIP_DURATION_MS,
    Math.max(0, proposedInPointMs),
  );
  let nextStartMs = clip.startMs + (nextInPointMs - clip.inPointMs);
  const snappedStartMs = snapValue(
    nextStartMs,
    trackBoundaryPoints(state, clip.trackId, clip.id),
  );
  if (snappedStartMs !== nextStartMs) {
    nextInPointMs = clip.inPointMs + (snappedStartMs - clip.startMs);
    nextInPointMs = Math.min(
      clip.outPointMs - MIN_CLIP_DURATION_MS,
      Math.max(0, nextInPointMs),
    );
    nextStartMs = clip.startMs + (nextInPointMs - clip.inPointMs);
  }
  const previous = previousClip(state, clip);

  if (previous) {
    const minStartMs = clipEndMs(previous);
    if (nextStartMs < minStartMs) {
      const delta = minStartMs - nextStartMs;
      nextStartMs = minStartMs;
      if (nextInPointMs + delta > clip.outPointMs - MIN_CLIP_DURATION_MS) {
        return state;
      }
      return withClips(
        state,
        state.clips.map((candidate) =>
          candidate.id === clipId
            ? {
                ...candidate,
                startMs: nextStartMs,
                inPointMs: nextInPointMs + delta,
              }
            : candidate,
        ),
      );
    }
  }

  return withClips(
    state,
    state.clips.map((candidate) =>
      candidate.id === clipId
        ? { ...candidate, startMs: nextStartMs, inPointMs: nextInPointMs }
        : candidate,
    ),
  );
}

export function trimClipEnd(
  state: EditorProjectState,
  clipId: string,
  proposedOutPointMs: number,
) {
  const clip = findClip(state, clipId);
  if (!clip) {
    return state;
  }

  const asset = findClipAsset(state, clip);
  const maxByAsset = asset?.durationMs ?? proposedOutPointMs;
  const next = nextClip(state, clip);
  const maxByTrack = next
    ? clip.inPointMs + Math.max(MIN_CLIP_DURATION_MS, next.startMs - clip.startMs)
    : maxByAsset;
  let nextOutPointMs = Math.min(
    Math.max(clip.inPointMs + MIN_CLIP_DURATION_MS, proposedOutPointMs),
    Math.min(maxByAsset, maxByTrack),
  );

  const snappedEndMs = snapValue(
    clip.startMs + (nextOutPointMs - clip.inPointMs),
    trackBoundaryPoints(state, clip.trackId, clip.id),
  );
  if (snappedEndMs !== clip.startMs + (nextOutPointMs - clip.inPointMs)) {
    nextOutPointMs = clip.inPointMs + (snappedEndMs - clip.startMs);
    nextOutPointMs = Math.min(
      Math.max(clip.inPointMs + MIN_CLIP_DURATION_MS, nextOutPointMs),
      Math.min(maxByAsset, maxByTrack),
    );
  }

  return withClips(
    state,
    state.clips.map((candidate) =>
      candidate.id === clipId
        ? { ...candidate, outPointMs: nextOutPointMs }
        : candidate,
    ),
  );
}

export function splitClipAt(state: EditorProjectState, clipId: string, atMs: number) {
  const clip = findClip(state, clipId);
  if (!clip) {
    return state;
  }

  const localOffsetMs = atMs - clip.startMs;
  if (
    localOffsetMs <= MIN_CLIP_DURATION_MS
    || clipDurationMs(clip) - localOffsetMs <= MIN_CLIP_DURATION_MS
  ) {
    return state;
  }

  const splitInPointMs = clip.inPointMs + localOffsetMs;
  const rightClip: TimelineClip = {
    ...clip,
    id: createId('clip'),
    startMs: atMs,
    inPointMs: splitInPointMs,
  };

  return withClips(
    state,
    state.clips.flatMap((candidate) => {
      if (candidate.id !== clip.id) {
        return [candidate];
      }

      return [
        {
          ...candidate,
          outPointMs: splitInPointMs,
        },
        rightClip,
      ];
    }),
    [rightClip.id],
  );
}

export function deleteSelectedClips(state: EditorProjectState) {
  if (state.selectedClipIds.length === 0) {
    return state;
  }

  return withClips(
    state,
    state.clips.filter((clip) => !state.selectedClipIds.includes(clip.id)),
    [],
  );
}

export function setSelectedClipMuted(state: EditorProjectState, muted: boolean) {
  if (state.selectedClipIds.length === 0) {
    return state;
  }

  return withClips(
    state,
    state.clips.map((clip) =>
      state.selectedClipIds.includes(clip.id) ? { ...clip, muted } : clip,
    ),
  );
}

export function removeAsset(state: EditorProjectState, assetId: string) {
  const remainingClips = state.clips.filter((clip) => clip.assetId !== assetId);
  return {
    ...state,
    assets: state.assets.filter((asset) => asset.id !== assetId),
    clips: remainingClips,
    selectedClipIds: state.selectedClipIds.filter((clipId) =>
      remainingClips.some((clip) => clip.id === clipId),
    ),
    dirty: true,
    isPlaying: false,
  };
}

export function addTrack(state: EditorProjectState) {
  const nextOrder = state.tracks.reduce((maxValue, track) => Math.max(maxValue, track.order), 0) + 1;
  const nextTrackNumber = state.tracks.length + 1;
  const nextTrack: TimelineTrack = {
    id: createId('track'),
    name: `Track ${nextTrackNumber}`,
    order: nextOrder,
  };

  return {
    ...state,
    tracks: [...state.tracks, nextTrack],
    dirty: true,
  };
}

export function removeTrack(state: EditorProjectState, trackId: string) {
  if (state.tracks.length <= 1) {
    return state;
  }

  const track = state.tracks.find((candidate) => candidate.id === trackId);
  if (!track) {
    return state;
  }

  const fallbackTrack = [...state.tracks]
    .filter((candidate) => candidate.id !== trackId)
    .sort((left, right) => Math.abs(left.order - track.order) - Math.abs(right.order - track.order))[0];

  if (!fallbackTrack) {
    return state;
  }

  let nextState: EditorProjectState = {
    ...state,
    tracks: state.tracks.filter((candidate) => candidate.id !== trackId),
  };

  for (const clip of sortByStart(state.clips.filter((candidate) => candidate.trackId === trackId))) {
    nextState = moveClip(nextState, clip.id, fallbackTrack.id, clip.startMs);
  }

  return {
    ...nextState,
    dirty: true,
    isPlaying: false,
  };
}

export function sortTracksDescending(tracks: TimelineTrack[]) {
  return [...tracks].sort((left, right) => right.order - left.order);
}