import { describe, expect, it } from 'vitest'

import { buildDefaultProjectState } from './model'
import { addTrack, setSelectedClipMuted, sortTracksInDisplayOrder } from './timelineCommands'

describe('timeline commands', () => {
  it('sorts tracks in ascending display order', () => {
    const tracks = [
      { id: 'track-3', name: 'Track 3', order: 3 },
      { id: 'track-1', name: 'Track 1', order: 1 },
      { id: 'track-2', name: 'Track 2', order: 2 },
    ]

    const sortedTracks = sortTracksInDisplayOrder(tracks)

    expect(sortedTracks.map((track) => track.name)).toEqual(['Track 1', 'Track 2', 'Track 3'])
  })

  it('appends newly created tracks at the bottom of the timeline', () => {
    const state = buildDefaultProjectState()

    const nextState = addTrack(state)

    expect(sortTracksInDisplayOrder(nextState.tracks).map((track) => track.order)).toEqual([1, 2, 3, 4])
    expect(nextState.tracks.at(-1)).toMatchObject({ name: 'Track 4', order: 4 })
  })

  it('mutes every selected clip without mutating the previous state', () => {
    const state = buildDefaultProjectState()
    state.clips = [
      {
        id: 'clip-1',
        assetId: 'asset-1',
        trackId: state.tracks[0].id,
        startMs: 0,
        inPointMs: 0,
        outPointMs: 1200,
        muted: false,
      },
    ]
    state.selectedClipIds = ['clip-1']

    const nextState = setSelectedClipMuted(state, true)

    expect(nextState.clips[0]?.muted).toBe(true)
    expect(state.clips[0]?.muted).toBe(false)
  })
})