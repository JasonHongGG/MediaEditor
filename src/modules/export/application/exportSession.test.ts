import { describe, expect, it } from 'vitest'

import { buildDefaultProjectState } from '../../editor/domain/model'
import { preparePendingExportSession } from './exportSession'

describe('preparePendingExportSession', () => {
  it('carries the render profile into the export snapshot', () => {
    const state = buildDefaultProjectState()
    state.documentName = 'Interview Cut'
    state.renderProfile = {
      format: 'mp4',
      fps: 120,
      videoQuality: '2160p',
      audioBitrateKbps: 320,
    }
    state.assets = [
      {
        id: 'asset-1',
        name: 'camera-a.mp4',
        path: 'C:/media/camera-a.mp4',
        kind: 'video',
        durationMs: 8000,
        hasVideo: true,
        hasAudio: true,
        width: 3840,
        height: 2160,
        status: 'ready',
        url: 'asset://camera-a.mp4',
        thumbnailUrl: null,
      },
    ]
    state.clips = [
      {
        id: 'clip-1',
        assetId: 'asset-1',
        trackId: state.tracks[0].id,
        startMs: 500,
        inPointMs: 1000,
        outPointMs: 4000,
        muted: false,
      },
    ]

    const snapshot = preparePendingExportSession(state)

    expect(snapshot.renderProfile).toEqual(state.renderProfile)
    expect(snapshot.timelineDurationMs).toBe(3500)
    expect(snapshot.dominantWidth).toBe(3840)
    expect(snapshot.sources).toHaveLength(1)
  })

  it('rejects exports while referenced media is missing', () => {
    const state = buildDefaultProjectState()
    state.assets = [
      {
        id: 'asset-1',
        name: 'missing.wav',
        path: 'C:/media/missing.wav',
        kind: 'audio',
        durationMs: 4000,
        hasVideo: false,
        hasAudio: true,
        width: undefined,
        height: undefined,
        status: 'missing',
        url: null,
        thumbnailUrl: null,
      },
    ]
    state.clips = [
      {
        id: 'clip-1',
        assetId: 'asset-1',
        trackId: state.tracks[0].id,
        startMs: 0,
        inPointMs: 0,
        outPointMs: 2000,
        muted: false,
      },
    ]

    expect(() => preparePendingExportSession(state)).toThrow('Relink missing media before exporting')
  })
})