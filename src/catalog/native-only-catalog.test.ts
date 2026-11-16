import { expect, it } from 'vitest'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from './bundled'
import { nativeIdentity } from '../domain/native-game'

it('ships a native-only baseline without community definitions or source claims', () => {
  expect(BUNDLED_CATALOGS.map(catalog => catalog.id)).toEqual(['crystal-project/vanilla'])
  expect(CURRENT_CATALOG.revisionId).not.toBe('v1')
  const sources: string[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if ('sourceId' in value && typeof value.sourceId === 'string') sources.push(value.sourceId)
    for (const child of Object.values(value)) visit(child)
  }
  visit(CURRENT_CATALOG)
  expect(sources.length).toBeGreaterThan(0)
  expect([...new Set(sources)].filter(source => !source.startsWith('native-game:'))).toEqual([])
  const native = Object.values(CURRENT_CATALOG.entities).filter(entity => nativeIdentity(entity))
  expect(native.find(entity => entity.name === 'Warrior' && nativeIdentity(entity)?.mode === 'base')?.kind).toBe('class')
  expect(native.every(entity => entity.aliases.length === 0)).toBe(true)
  expect(Object.values(CURRENT_CATALOG.entities).some(entity => entity.fields['Wiki coverage'])).toBe(false)
})
