import type { EditorAsset, EditorProjectState } from '../domain/model';
import { buildDefaultProjectState, clamp, MAX_ZOOM, MIN_ZOOM } from '../domain/model';
import {
  addTrack,
  deleteSelectedClips,
  insertClip,
  moveClip,
  removeAsset,
  removeTrack,
  replaceProjectState,
  resetProjectState,
  setSelectedClipMuted,
  splitClipAt,
  trimClipEnd,
  trimClipStart,
} from '../domain/timelineCommands';

export type EditorAction =
  | { type: 'reset-project' }
  | { type: 'replace-project'; nextState: EditorProjectState }
  | { type: 'set-document-path'; documentPath: string | null; documentName: string }
  | { type: 'mark-saved'; documentPath: string | null; documentName: string }
  | { type: 'add-assets'; assets: EditorAsset[] }
  | { type: 'remove-asset'; assetId: string }
  | { type: 'relink-asset'; assetId: string; asset: EditorAsset }
  | { type: 'set-selection'; clipIds: string[] }
  | { type: 'insert-clip'; assetId: string; trackId: string; startMs: number }
  | { type: 'move-clip'; clipId: string; trackId: string; startMs: number }
  | { type: 'trim-clip-start'; clipId: string; inPointMs: number }
  | { type: 'trim-clip-end'; clipId: string; outPointMs: number }
  | { type: 'split-clip'; clipId: string; atMs: number }
  | { type: 'delete-selected-clips' }
  | { type: 'set-selected-clips-muted'; muted: boolean }
  | { type: 'set-playhead'; playheadMs: number }
  | { type: 'set-playing'; isPlaying: boolean }
  | { type: 'set-zoom'; zoom: number }
  | { type: 'set-preview-volume'; previewVolume: number }
  | { type: 'set-preview-muted'; previewMuted: boolean }
  | { type: 'add-track' }
  | { type: 'remove-track'; trackId: string };

export function createInitialEditorState() {
  return buildDefaultProjectState();
}

export function editorReducer(state: EditorProjectState, action: EditorAction): EditorProjectState {
  switch (action.type) {
    case 'reset-project':
      return resetProjectState();

    case 'replace-project':
      return replaceProjectState(state, action.nextState);

    case 'set-document-path':
      return {
        ...state,
        documentPath: action.documentPath,
        documentName: action.documentName,
      };

    case 'mark-saved':
      return {
        ...state,
        documentPath: action.documentPath,
        documentName: action.documentName,
        dirty: false,
      };

    case 'add-assets': {
      const existingPaths = new Set(state.assets.map((asset) => asset.path));
      const nextAssets = action.assets.filter((asset) => !existingPaths.has(asset.path));
      if (nextAssets.length === 0) {
        return state;
      }

      return {
        ...state,
        assets: [...state.assets, ...nextAssets],
        dirty: true,
      };
    }

    case 'remove-asset':
      return removeAsset(state, action.assetId);

    case 'relink-asset':
      return {
        ...state,
        assets: state.assets.map((asset) =>
          asset.id === action.assetId ? { ...action.asset, id: asset.id } : asset,
        ),
        dirty: true,
      };

    case 'set-selection':
      return {
        ...state,
        selectedClipIds: action.clipIds,
      };

    case 'insert-clip':
      return insertClip(state, action.assetId, action.trackId, action.startMs);

    case 'move-clip':
      return moveClip(state, action.clipId, action.trackId, action.startMs);

    case 'trim-clip-start':
      return trimClipStart(state, action.clipId, action.inPointMs);

    case 'trim-clip-end':
      return trimClipEnd(state, action.clipId, action.outPointMs);

    case 'split-clip':
      return splitClipAt(state, action.clipId, action.atMs);

    case 'delete-selected-clips':
      return deleteSelectedClips(state);

    case 'set-selected-clips-muted':
      return setSelectedClipMuted(state, action.muted);

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

    case 'set-preview-volume':
      return {
        ...state,
        previewVolume: clamp(action.previewVolume, 0, 1),
      };

    case 'set-preview-muted':
      return {
        ...state,
        previewMuted: action.previewMuted,
      };

    case 'add-track':
      return addTrack(state);

    case 'remove-track':
      return removeTrack(state, action.trackId);

    default:
      return state;
  }
}

export const initialEditorState = buildDefaultProjectState();