import { describe, expect, it } from 'vitest'
import { formatCatalogSourceId, importedJsonRevision, parseCatalogSourceId, parseSourceRevision } from './source-identity'

const digest = 'a'.repeat(64)

describe('canonical catalog sources', () => {
  it.each([
    ['crystal-project/vanilla', { game: 'crystal-project', origin: 'vanilla' }],
    ['crystal-project/mod/dirk-god-mode', { game: 'crystal-project', origin: 'mod', key: 'dirk-god-mode' }],
    ['crystal-project/guide/modding', { game: 'crystal-project', origin: 'guide', key: 'modding' }],
    [`crystal-project/imported/ce1-${digest}`, { game: 'crystal-project', origin: 'imported', key: `ce1-${digest}` }],
  ] as const)('resolves %s without display aliases', (id, identity) => {
    expect(parseCatalogSourceId(id)).toEqual(identity)
    expect(formatCatalogSourceId(identity)).toBe(id)
  })

  it.each(['crystal-project-public-starter', 'crystal-project/vanilla/extra', 'crystal-project/mod', 'crystal-project/mod/Name', 'crystal-project/mod/a%2Fb', 'other-game/vanilla', 'crystal-project/imported/ce1-short', 'crystal-project/guide/../modding', 'crystal-project/guide/a\n'])('rejects a noncanonical source %j', id => {
    expect(parseCatalogSourceId(id)).toBeUndefined()
  })

  it('rejects invalid source construction instead of emitting an unresolvable identity', () => {
    expect(() => formatCatalogSourceId({ game: 'crystal-project', origin: 'mod', key: 'a/b' })).toThrow()
  })

  it('pins bundled and imported revisions under independent source contracts', () => {
    expect(parseSourceRevision('vanilla', 'v1')).toEqual({ kind: 'bundled', version: 1 })
    expect(parseSourceRevision('guide', 'v2')).toEqual({ kind: 'bundled', version: 2 })
    expect(importedJsonRevision(`json-content-v1:sha256:${digest}`, 'p1')).toBe(`j1-${digest}-p1`)
    expect(parseSourceRevision('imported', `j1-${digest}-p1`)).toEqual({ kind: 'imported', encoding: 'j1', digest, interpretation: 'p1' })
    expect(parseSourceRevision('imported', 'v1')).toBeUndefined()
    expect(parseSourceRevision('vanilla', `j1-${digest}-p1`)).toBeUndefined()
    for (const version of ['v0', 'v01', 'v9007199254740992']) expect(parseSourceRevision('vanilla', version)).toBeUndefined()
    expect(() => importedJsonRevision(`sha256:${digest}`, 'p1')).toThrow()
    expect(() => importedJsonRevision(`json-content-v1:sha256:${digest}`, 'latest')).toThrow()
  })
})
