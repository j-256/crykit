import { describe, expect, it } from 'vitest'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { describeNativeRecord, formatNativeTemplate, nativeDescriptionRecord, nativeVocabularyText } from './native-description'
import { nativeRecord, type NativeGameSnapshot, type NativeRecord } from './native-game'

const snapshot = NATIVE_GAME_DATA
const system = snapshot.databases.system as NativeRecord
const vocabulary = system.Vocab as NativeRecord
const general = vocabulary.General as NativeRecord
const record = (family: string, id: number) => nativeDescriptionRecord(snapshot, family, id)!
const tag = (family: string, name: string) => Number(Object.entries(snapshot.enums[family]!).find(([, value]) => value === name)![0])
const stat = (name: string, value1: number, value2 = 0, value3 = 0) => ({ Tag: tag('SangStatModTag', name), Value1: value1, Value2: value2, Value3: value3 })
const describeAbility = (changes: NativeRecord) => describeNativeRecord(snapshot, 'ability', { ...record('ability', 362), ...changes })

describe('native description templates', () => {
  it('expands vocabulary aliases before numbers and keeps native sign semantics', () => {
    expect(formatNativeTemplate(['@V.PAtk', '@V.Sep', '[v1s]'].join(''), general, 30)).toBe('Attack:  +30')
    expect(formatNativeTemplate('[Iv1] [r1a]% [v2~] [amp] [l]', general, -20, -3, 'label')).toBe('Decreased 120% +3 & label')
    expect(nativeVocabularyText('@V.SubJob @V.Job @V.Sep', general)).toBe('Sub-Command Class :')
  })

  it('declines unsupported, recursive, oversized, and malformed templates without executing text', () => {
    for (const value of ['', '[missing]', '[v1', '@V.Unknown', '@X.Unreviewed', 'a'.repeat(16_385)]) expect(formatNativeTemplate(value, general, 1)).toBeUndefined()
    expect(formatNativeTemplate('[v1]', general, Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(nativeVocabularyText('@V.HP', { HP: '@V.HP' })).toBeUndefined()
    expect(nativeVocabularyText('@V.HP', { HP: '@V.MP', MP: '@V.HP' })).toBeUndefined()
    expect(nativeVocabularyText('globalThis.untrusted()', general)).toBe('globalThis.untrusted()')
    expect(nativeVocabularyText('@VxHP', general)).toBeUndefined()
  })

  it('renders native equipment modifier facts even when the authored Description is null', () => {
    expect(describeNativeRecord(snapshot, 'equipment', record('equipment', 0))).toEqual({ lines: ['Attack:  +30'], complete: true, unresolved: [] })
    expect(describeNativeRecord(snapshot, 'equipment', record('equipment', 320))).toMatchObject({ lines: ['Dexterity:  +14', 'Agility:  +16', 'Only one can be equipped at a time.'], complete: true })
  })

  it('keeps an on-hit status explanation with its trigger, duration, and chance', () => {
    expect(describeNativeRecord(snapshot, 'equipment', record('equipment', 41))).toEqual({
      lines: ['Attack:  +300', 'Crit. Damage:  +26%', 'On hit, inflict: Blind for 1 turn (10% chance). Blind effect: Always miss physical attacks.'],
      complete: true,
      unresolved: [],
    })
    expect(describeNativeRecord(snapshot, 'status', record('status', 7)).lines).toContain('Always miss physical attacks.')
  })

  it('retains the on-hit application when the nested status cannot be fully described', () => {
    const status = { ...record('status', 7), StatMods: [stat('Flat_HP', 5), { Tag: -1, Value1: 0, Value2: 0, Value3: 0 }] }
    const changed = { ...snapshot, databases: { ...snapshot.databases, status: [status] } }
    expect(describeNativeRecord(changed, 'equipment', { StatMods: [stat('PStatusApply', 7, 25, 3)] })).toEqual({
      lines: ['On hit, inflict: Blind for 3 turns (25% chance). Blind effect: Max. HP:  +5'],
      complete: false,
      unresolved: ['Unknown stat modifier'],
    })
    expect(describeNativeRecord(changed, 'equipment', { StatMods: [stat('PStatusApply', 7, 101, 3)] })).toMatchObject({ lines: [], complete: false })
    expect(describeNativeRecord(snapshot, 'equipment', { StatMods: [stat('PStatusApply', 7, 25, 3)] }, 'base', 4)).toEqual({
      lines: ['On hit, inflict: Blind for 3 turns (25% chance).'],
      complete: false,
      unresolved: ['Unresolved status description'],
    })
  })

  it('resolves reviewed static battle settings and class references for passive text', () => {
    expect(describeNativeRecord(snapshot, 'passive', record('passive', 43))).toMatchObject({ lines: ['Hold a One-Handed weapon with both hands to increase its attack by 50.'], complete: true })
    expect(describeNativeRecord(snapshot, 'passive', record('passive', 58))).toMatchObject({ lines: ["Learn Monster Magic by seeing an enemy use it, even while you're not a Scholar."], complete: true })
    expect(describeNativeRecord(snapshot, 'passive', record('passive', 55)).lines).not.toEqual(describeNativeRecord(snapshot, 'passive', record('passive', 58)).lines)
  })

  it('uses native per-level and per-turn suffixes without inventing a description for empty templates', () => {
    const modifier = stat('Flat_HP_PerLevel', 2, 3)
    const entity = { Description: null, StatMods: [modifier] }
    expect(describeNativeRecord(snapshot, 'passive', entity)).toMatchObject({ lines: ['Max. HP:  +2 per 3 levels'], complete: true })
    const templates = [...vocabulary.StatModText as readonly string[]]
    templates[modifier.Tag] = ''
    const missing = { ...snapshot, databases: { ...snapshot.databases, system: { ...system, Vocab: { ...vocabulary, StatModText: templates } } } }
    expect(describeNativeRecord(missing, 'passive', entity)).toMatchObject({ lines: [], complete: false })
    expect(describeNativeRecord(snapshot, 'passive', { StatMods: [stat('Flat_HP_PerTurn', -2, 4)] })).toMatchObject({ lines: ['Max. HP:  -2 per turn  (min: -8)'], complete: true })
  })

  it('honors hidden stat modifiers and preserves unknown visible cases', () => {
    const entity = { Description: 'Native text', HideStatModsFromDescription: true, StatMods: [{ Tag: -1, Value1: 0, Value2: 0, Value3: 0 }] }
    expect(describeNativeRecord(snapshot, 'equipment', entity)).toMatchObject({ lines: ['Native text'], complete: true })
    expect(describeNativeRecord(snapshot, 'equipment', { ...entity, HideStatModsFromDescription: false })).toMatchObject({ lines: ['Native text'], complete: false })
  })
})

describe('native ability and item descriptions', () => {
  it('renders the reviewed missing-HP stew effect and simple fixed healing from native item abilities', () => {
    expect(describeNativeRecord(snapshot, 'item', record('item', 132))).toEqual({ lines: ['Single target.', 'Recovery:  100% Missing HP'], complete: true, unresolved: [] })
    expect(describeNativeRecord(snapshot, 'item', record('item', 0))).toMatchObject({ lines: ['Single target.', 'Recovery:  250 HP'], complete: true })
    expect(describeAbility({ AbilityMods: [{ Tag: 43, Value1: -100, Value2: 3 }] })).toMatchObject({ complete: false, unresolved: ['Ability modifier: DamageRateMissing_100'] })
  })

  it('uses separate visibility rules for percentage power and modifier text', () => {
    expect(describeAbility({ HideModsFromDescription: true }).lines).toContain('Recovery:  100% Missing HP')
    expect(describeAbility({ HideDamageFromDescription: true }).lines).not.toContain('Recovery:  100% Missing HP')
    expect(describeAbility({ BasePAtkRate: 120, IsPAbil: true })).toMatchObject({ complete: false })
  })

  it('honors scope locking and positive costs even when displaying an item ability', () => {
    expect(describeAbility({ ScopeLocked: true }).lines[0]).toBe('Single ally ability.')
    const ability = { ...record('ability', 362), HPCost: -5, MPCost: 2, CDCost: 3 }
    const changed: NativeGameSnapshot = { ...snapshot, databases: { ...snapshot.databases, ability: [ability] } }
    expect(describeNativeRecord(changed, 'item', record('item', 132)).lines).toEqual(['Single target.', 'Cost: 2 MP, 3 CD.', 'Recovery:  100% Missing HP'])
  })

  it('distinguishes removal, zero counts, permanent status, and status-specific duration conditions', () => {
    const statuses = [
      { StatusID: 1, Chance: 25, Count: -1 },
      { StatusID: 999999, Chance: 100, Count: 0 },
      { StatusID: 1, Chance: 100, Count: 255 },
      { StatusID: 1, Chance: 50, Count: 3 },
    ]
    const description = describeAbility({ AbilityMods: [], TargetStatuses: statuses })
    expect(description.lines).toContain('Remove:  Chakra (25%)')
    expect(description.lines).toContain('Apply: Chakra (permanent).')
    expect(description.lines).toContain('Apply: Chakra for 3 turns (50% chance).')
    expect(description.lines.join('\n')).not.toMatch(/255 ticks|0 ticks|999999/)
    expect(description.complete).toBe(true)
  })

  it('uses stat status Value2 for chance and Value3 for duration and includes nested effects', () => {
    const description = describeNativeRecord(snapshot, 'passive', { StatMods: [stat('StatusAuto', 1, 25, 3)] })
    expect(description.lines).toContain('At battle start, get: Chakra for 3 turns (25% chance).')
    expect(description.lines).toContain('Healing per turn:  30%')
    expect(description.complete).toBe(true)
  })

  it('bounds recursive status references and retains their incomplete result without mutating the source', () => {
    const recursive: NativeRecord = { ID: 1, Name: 'Synthetic loop', Description: 'Synthetic loop facts', HideDurationFromDescription: true, StatMods: [stat('StatusAuto', 1, 100, 255)] }
    const changed: NativeGameSnapshot = { ...snapshot, databases: { ...snapshot.databases, status: [recursive] } }
    const original = structuredClone(recursive)
    expect(describeNativeRecord(changed, 'status', recursive)).toEqual({
      lines: ['Synthetic loop facts', 'At battle start, get: Synthetic loop (permanent).'],
      complete: false,
      unresolved: ['Unresolved status description'],
    })
    expect(recursive).toEqual(original)
    expect(nativeDescriptionRecord(changed, 'status', 1)).toBe(recursive)
  })

  it('preserves authored, ability, nested status, and flavor order in an item description', () => {
    const ability: NativeRecord = { ...record('ability', 362), Description: 'Synthetic ability', AbilityMods: [], TargetStatuses: [{ StatusID: 1, Chance: 100, Count: 255 }] }
    const status: NativeRecord = { ID: 1, Name: 'Synthetic status effect', Description: 'Synthetic status', HideDurationFromDescription: true, HideStatModsFromDescription: true }
    const item: NativeRecord = { Description: 'Synthetic item', AbilityID: 362, Flavor: 'Synthetic flavor' }
    const changed: NativeGameSnapshot = { ...snapshot, databases: { ...snapshot.databases, ability: [ability], status: [status] } }
    expect(describeNativeRecord(changed, 'item', item)).toEqual({
      lines: ['Synthetic item', 'Synthetic ability', 'Single target.', 'Apply: Synthetic status effect (permanent).', 'Synthetic status', 'Synthetic flavor'],
      complete: true,
      unresolved: [],
    })
  })

  it('rejects unknown modes and resolves a known mode through its own overrides', () => {
    expect(nativeDescriptionRecord(snapshot, 'item', 132, 'unverified-mode')).toBeUndefined()
    expect(describeNativeRecord(snapshot, 'item', record('item', 132), 'unverified-mode')).toMatchObject({ lines: [], complete: false })
    const patch = (snapshot.databases.patch as NativeRecord[]).find(value => value.Name === 'Vanilla')!
    const changed = (patch.Abilities as NativeRecord[]).find(nativeRecord)!
    expect(nativeDescriptionRecord(snapshot, 'ability', changed.ID as number, 'Vanilla')).toBe(changed)
  })
})
