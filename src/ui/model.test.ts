import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { previewImport } from '../interchange/import'
import type { CatalogSnapshot, GameSetupRevision } from '../domain/types'
import { gameSetupModSummary, ownRecordValue } from './model'

describe('ownRecordValue', () => {
  it('accepts own prototype-shaped keys without reading inherited properties', () => {
    const record = JSON.parse('{"constructor":"own constructor","__proto__":"own prototype"}') as Record<string, string>

    expect(ownRecordValue(record, 'constructor')).toBe('own constructor')
    expect(ownRecordValue(record, '__proto__')).toBe('own prototype')
    expect(ownRecordValue({}, 'constructor')).toBeUndefined()
    expect(ownRecordValue({}, '__proto__')).toBeUndefined()
  })
})

describe('Game Setup mod names', () => {
  const setup = (catalog: CatalogSnapshot, enabled = true): Pick<GameSetupRevision, 'mods' | 'modComposition'> => ({ mods: { state: 'known', value: [] }, modComposition: { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled }], links: [] } })
  const imported = async (Title: string) => (await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-display', Title, EditorVersion: 34, Jobs: [] })), 'synthetic-display.json')).proposed.catalogs[0]!

  it('uses the enabled exact revision instead of another available revision title', async () => {
    const first = await imported('Synthetic earlier title')
    const later = await imported('Synthetic later title')
    expect(gameSetupModSummary(setup(first), [later, first])).toBe('Enabled: Synthetic earlier title')
    expect(gameSetupModSummary(setup(first, false), [later, first])).toBe('No mods selected')
    expect(gameSetupModSummary(setup(first), [later])).toBe('Enabled: Unavailable mod source')
  })

  it('distinguishes enabled source data from named-only settings', async () => {
    const catalog = await imported('Synthetic display')
    expect(gameSetupModSummary({ ...setup(catalog), mods: { state: 'known', value: ['Unverified rules'] } }, [catalog])).toBe('Enabled: Synthetic display · Named only: Unverified rules')
    expect(gameSetupModSummary({ mods: { state: 'unknown' } }, [catalog])).toBe('Mods unresolved')
  })
})
