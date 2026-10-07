import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import { NATIVE_RECORD_FIELD, nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, CatalogRef, CatalogSnapshot } from '../domain/types'
import { CombatAbilitySummary } from './CombatAbilitySummary'

const localData = createBlankLocalData()
const cuts = DEFAULT_CATALOG.entities['base:ability:203']!
const cutsRef: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: cuts.id }
const render = (abilityRef: CatalogRef = cutsRef, catalogs: readonly CatalogSnapshot[] = [DEFAULT_CATALOG]) => renderToStaticMarkup(<CombatAbilitySummary abilityRef={abilityRef} catalogs={catalogs} localData={localData}/>)
const withAbility = (ability: CatalogEntity): CatalogSnapshot => ({ ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [ability.id]: ability } })
const unavailableSources: readonly CatalogEntity['fields'][] = [
  {},
  { [NATIVE_RECORD_FIELD]: { state: 'unknown', reason: 'Synthetic missing source' } },
  { [NATIVE_RECORD_FIELD]: { state: 'conflicting', claims: [] } },
  { ...cuts.fields, 'Crystal Edit source record': { state: 'known', value: nativeSourceRecord(cuts)! }, 'Crystal Edit editor version': { state: 'known', value: 999 } },
]

describe('combat ability summary', () => {
  it('shows the selected native identity and base facts without promising fixed final damage or artwork', () => {
    const markup = render()
    expect(markup).toContain('aria-label="Selected ability"')
    expect(markup).toContain('<h4>1000 Cuts</h4>')
    expect(markup).toContain('<dt>Type</dt><dd>Magic</dd>')
    expect(markup).toContain('<dt>Base scope</dt><dd>Single target</dd>')
    expect(markup).toContain('<dt>Ability element</dt><dd>None</dd>')
    expect(markup).toContain('Base power: 1,000 HP')
    expect(markup).toContain('Before scaling and battle modifiers.')
    expect(markup).toContain('data-artwork-placeholder="ability"')
    expect(markup).not.toMatch(/enemy|Enemy|fixed|damage|cost|Cost|<img/)
  })

  it('uses the selected effective record instead of the baseline record or its old description', () => {
    const source = { ...nativeSourceRecord(cuts)!, Name: 'Synthetic revised magic', Element: 1, Scope: 1, BasePower: 250, AbilityMods: [{ Tag: 20, Value1: 0, Value2: 0 }] }
    const changed: CatalogEntity = { ...cuts, name: source.Name, fields: { ...cuts.fields, 'Crystal Edit source record': { state: 'known', value: source }, 'Crystal Edit editor version': { state: 'known', value: 34 }, 'Crystal Edit model type': { state: 'known', value: 'Abilities' } } }
    const effective = { ...withAbility(changed), revisionId: 'synthetic-effective-revision' as CatalogSnapshot['revisionId'] }
    const markup = render({ ...cutsRef, catalogRevisionId: effective.revisionId }, [DEFAULT_CATALOG, effective])
    expect(markup).toContain('Synthetic revised magic')
    expect(markup).toContain('<dt>Base scope</dt><dd>Multiple targets</dd>')
    expect(markup).toContain('<dt>Ability element</dt><dd>Ice</dd>')
    expect(markup).toContain('Base power: 250 HP')
    expect(markup).toContain("This ability has additional effects. Check the battle results; no description is available.")
    expect(markup).not.toContain('1,000')
    expect(markup).not.toContain('Never misses')
  })

  it('renders supported native special behavior separately from scope and resource costs', () => {
    const thunder = Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === 'Thunder Chop')!
    const markup = render({ ...cutsRef, entityId: thunder.id })
    expect(markup).toContain('Base effects')
    expect(markup).toContain('Never misses')
    expect(markup).not.toContain('Cost:')
  })

  it.each(unavailableSources)('keeps unavailable or conflicting source details unknown without baseline fallback', fields => {
    const markup = render(cutsRef, [withAbility({ ...cuts, fields })])
    expect(markup).toContain('<dt>Type</dt><dd>Unknown</dd>')
    expect(markup).toContain('<dt>Ability element</dt><dd>Unknown</dd>')
    expect(markup).toContain("Ability details are unavailable")
    expect(markup).not.toContain('1,000')
  })

  it('retains the mod setup warning when the selected source is not enabled', () => {
    const markup = render(cutsRef, [withAbility({ ...cuts, fields: { ...cuts.fields, 'Source mod': { state: 'known', value: 'Synthetic unconfirmed mod' } } })])
    expect(markup).toContain('Synthetic unconfirmed mod is not recorded as enabled in this Game Setup')
    expect(markup).toContain('<dt>Type</dt><dd>Unknown</dd>')
    expect(markup).not.toContain('1,000')
  })
})
