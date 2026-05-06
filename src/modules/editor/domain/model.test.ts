import { describe, expect, it } from 'vitest'

import { DEFAULT_RENDER_PROFILE, buildDefaultProjectState, toProjectDocument } from './model'

describe('editor model', () => {
  it('starts new projects with an explicit render profile', () => {
    const state = buildDefaultProjectState()

    expect(state.renderProfile).toEqual(DEFAULT_RENDER_PROFILE)
    expect(state.renderProfile.fps).toBe(60)
  })

  it('starts new projects with ascending track order from top to bottom', () => {
    const state = buildDefaultProjectState()

    expect(state.tracks.map((track) => track.name)).toEqual(['Track 1', 'Track 2', 'Track 3'])
    expect(state.tracks.map((track) => track.order)).toEqual([1, 2, 3])
  })

  it('serializes version 2 documents without workspace-only session fields', () => {
    const state = buildDefaultProjectState()
    state.documentName = 'Sequence A'
    state.renderProfile = {
      format: 'mkv',
      fps: 120,
      videoQuality: '1440p',
      audioBitrateKbps: 256,
    }

    const document = toProjectDocument(state)

    expect(document.version).toBe(2)
    expect(document.renderProfile).toEqual(state.renderProfile)
    expect(document).not.toHaveProperty('playheadMs')
    expect(document).not.toHaveProperty('zoom')
    expect(document).not.toHaveProperty('previewVolume')
    expect(document).not.toHaveProperty('previewMuted')
  })
})