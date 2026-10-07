import { describe, expect, it } from 'vitest'
import { changesModDraftContext, modEditorView, modWorkspaceRoute } from './mod-workspace'
import { formatAppRoute, parseAppRoute, routeDestination } from './navigation'

describe('Mods workspace navigation', () => {
  it('opens each editor view with an explicit query and keeps Mods selected', () => {
    const map = modWorkspaceRoute('map', { draft: ['synthetic'], view: ['dictionary'] })
    expect(formatAppRoute(map)).toBe('#/mods/editor?draft=synthetic&view=map')
    expect(parseAppRoute(formatAppRoute(map))).toEqual(map)
    expect(routeDestination(map)).toBe('mods')
    expect(modEditorView(map.query)).toBe('map')
    expect(modWorkspaceRoute('document', map.query).query).toEqual({ draft: ['synthetic'] })
    expect(modEditorView({ view: ['unknown'] })).toBe('document')
    expect(modWorkspaceRoute('library', map.query).query).toEqual({})
  })

  it('protects pending map edits and draft identity while allowing dictionary research', () => {
    const document = modWorkspaceRoute('document', { draft: ['synthetic'] })
    const map = modWorkspaceRoute('map', document.query)
    const dictionary = modWorkspaceRoute('dictionary', document.query)
    expect(changesModDraftContext(document, map)).toBe(true)
    expect(changesModDraftContext(map, document)).toBe(true)
    expect(changesModDraftContext(map, dictionary)).toBe(true)
    expect(changesModDraftContext(document, dictionary)).toBe(false)
    expect(changesModDraftContext(dictionary, document)).toBe(false)
    expect(changesModDraftContext(map, { ...map, query: { ...map.query, unrelated: ['filter'] } })).toBe(false)
    expect(changesModDraftContext(document, modWorkspaceRoute('document', { draft: ['other'] }))).toBe(true)
  })
})
