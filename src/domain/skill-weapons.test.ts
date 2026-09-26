import { describe, expect, it } from 'vitest'
import type { CatalogEntity, JsonValue, Knowledge } from './types'
import { normalizeWeaponType, skillAcceptsWeapon, skillWeaponRule } from './skill-weapons'

const rule = (value: Knowledge<JsonValue>, kind: CatalogEntity['kind'] = 'ability') => skillWeaponRule({ kind, fields: { Type: value } })
const known = (value: string) => rule({ state: 'known', value })

describe('skill weapon requirements', () => {
  it('recognizes explicit weapon lists in either order and generic weapon skills', () => {
    for (const type of ['Single target Dagger skill', 'Single target Dagger/Rapier skill', 'Single target Axe/Dagger skill', 'Multi-target weapon skill']) {
      expect(skillAcceptsWeapon(known(type), 'Dagger')).toMatchObject({ state: 'known', value: true })
    }
    expect(skillAcceptsWeapon(known('Single target Unarmed/Staff skill'), 'Dagger')).toMatchObject({ state: 'known', value: false })
    expect(skillAcceptsWeapon(known('Single target Unarmed/Staff skill'), 'Unarmed')).toMatchObject({ state: 'known', value: true })
    expect(normalizeWeaponType('staves')).toBe('Staff')
    expect(normalizeWeaponType('daggers')).toBe('Dagger')
  })

  it('excludes magic, ordinary actions, stances, and non-skill definitions', () => {
    for (const type of ['Single target magic', 'Single enemy ability', 'Stance change\nDoes not use the turn']) {
      expect(skillAcceptsWeapon(known(type), 'Dagger', 'enabled')).toMatchObject({ state: 'known', value: false })
    }
    expect(skillAcceptsWeapon(rule({ state: 'known', value: 'Single target Dagger skill' }, 'item'), 'Dagger')).toEqual({ state: 'known', value: false })
  })

  it('keeps incomplete and conflicting requirements uncertain without partially accepting a weapon list', () => {
    for (const value of [{ state: 'unknown' }, { state: 'known', value: '-' }, { state: 'known', value: 'Single target Dagger/Undocumented skill' }, { state: 'notApplicable' }] as const) {
      expect(skillAcceptsWeapon(rule(value), 'Dagger').state).toBe('unknown')
    }
    const conflicting = rule({ state: 'conflicting', claims: [
      { value: 'Single target Dagger skill', sources: [{ sourceId: 'first' }] },
      { value: 'Single target Sword skill', sources: [{ sourceId: 'second' }] },
    ] })
    expect(skillAcceptsWeapon(conflicting, 'Dagger')).toEqual({ state: 'conflicting', claims: [
      { value: true, sources: [{ sourceId: 'first' }] },
      { value: false, sources: [{ sourceId: 'second' }] },
    ] })
  })

  it('applies unrestricted weapon skills only when enabled and preserves unknown types', () => {
    const sword = known('Single target Sword skill')
    expect(skillAcceptsWeapon(sword, 'Dagger', 'enabled')).toMatchObject({ state: 'known', value: true })
    for (const state of ['disabled', 'unknown'] as const) expect(skillAcceptsWeapon(sword, 'Dagger', state)).toMatchObject({ state: 'known', value: false })
    expect(skillAcceptsWeapon(sword, 'Dagger', 'conflicting').state).toBe('unknown')
    expect(skillAcceptsWeapon(rule({ state: 'unknown' }), 'Dagger', 'enabled').state).toBe('unknown')
  })
})
