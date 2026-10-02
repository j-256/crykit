import guide from './guide-mechanics.json' with { type: 'json' }
import type { CatalogEntity, CatalogSnapshot, EntityId, SourceRef } from '../domain/types'

export const MODDING_GUIDE_SOURCE: SourceRef = guide.source

export function addModdingGuideFacts(base: CatalogSnapshot): CatalogSnapshot {
  const entities = { ...base.entities }
  for (const entry of guide.entries) {
    const id = `base:mechanic:${entry.category === 'Stat modifiers' ? 'stat' : 'ability'}:${encodeURIComponent(entry.name)}` as EntityId
    const source = { ...MODDING_GUIDE_SOURCE, locator: entry.locator }
    const previous = entities[id]
    if (previous) {
      const description = previous.fields.Description
      const claims = description?.state === 'conflicting' ? description.claims : description?.state === 'known' ? [{ value: description.value, sources: description.sources ?? previous.sources }] : []
      entities[id] = { ...previous, rawDescription: 'The guide gives differing descriptions for this modifier. Review the source claims below.', fields: { ...previous.fields, Description: { state: 'conflicting', claims: [...claims, { value: entry.description, sources: [source] }] } }, sources: [...previous.sources, source] }
      continue
    }
    entities[id] = {
      id, kind: 'other', name: entry.name, aliases: [], rawDescription: entry.description,
      fields: { Description: { state: 'known', value: entry.description, sources: [source] }, Category: { state: 'known', value: ['Mechanics', entry.category], sources: [source] }, 'Evidence scope': { state: 'known', value: 'Community guide description; not an automatically applied build rule', sources: [source] } },
      sources: [source],
    }
  }
  const caveatId = 'base:mechanic:growth-and-damage' as EntityId
  const source = { ...MODDING_GUIDE_SOURCE, locator: 'Game synopsis > Growths; Abilities > Formula construction' }
  const formulaEntity: CatalogEntity = {
    id: caveatId, kind: 'other', name: 'Growth estimates and damage formula research', aliases: ['Stat calculator', 'Damage calculation', 'Growth formula'],
    rawDescription: 'This entry preserves community formula research. Class and loadout calculators use verified Windows PC rules. The discrepancies below describe the community source and are not calculation inputs.',
    fields: {
      Category: { state: 'known', value: ['Mechanics', 'Formulas'], sources: [source] },
      'Growth inputs': { state: 'known', value: ['Primary class ratings', 'Level', 'Levels allocated to each growth class', 'Explicit stat bonuses'], sources: [source] },
      'Unresolved damage details': { state: 'known', value: ['The variance description places variance before critical hits; the final pipeline reverses them', 'The guide uses UserPower + TargetPower in the reduction denominator; the developer post uses 2 * TargetPower', 'The guide does not specify all intermediate rounding and remaining multiplier order'], sources: [source] },
    }, sources: [source, { sourceId: 'https://steamcommunity.com/app/1637730/discussions/0/676199918678875437/', locator: 'Developer reply dated 2024-12-17', applicability: 'Published defense formula; discrepancy retained for investigation' }],
  }
  entities[caveatId] = formulaEntity
  return { ...base, entities }
}
