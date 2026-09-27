import vanilla from './vanilla-jobs.json' with { type: 'json' }
import guide from './guide-mechanics.json' with { type: 'json' }
import { classFields } from '../domain/crystal-edit'
import type { CatalogEntity, CatalogRevisionId, CatalogSnapshot, EntityId, JsonValue, SourceRef } from '../domain/types'

export const VANILLA_CLASS_SOURCE: SourceRef = vanilla.source
export const MODDING_GUIDE_SOURCE: SourceRef = guide.source
export const CRYSTAL_EDIT_REVISION = 'crystal-edit-v1' as CatalogRevisionId
export const CRYSTAL_EDIT_CHECKSUM = 'builtin:sha256:5a22bed4b9ccaebdf0a68451847a0de5413dc017a36ed3a90e3879998256cb72'

export function enrichWithCrystalEdit(base: CatalogSnapshot): CatalogSnapshot {
  const entities = { ...base.entities }
  for (const [index, job] of vanilla.jobs.entries()) {
    const id = `base:class:${job.Name.toLowerCase()}`
    const original = entities[id]
    if (original?.kind !== 'class' || original.name !== job.Name) throw new Error(`Missing reviewed vanilla class identity: ${job.Name}`)
    const source = { ...VANILLA_CLASS_SOURCE, locator: `/Jobs/${index}; copied job ID ${job.ID}` }
    entities[id] = {
      ...original,
      fields: { ...original.fields, ...classFields(job, source), 'Crystal Edit copied job ID': { state: 'known', value: job.ID, sources: [source] } },
      sources: [...original.sources, source],
    }
  }
  for (const entry of guide.entries) {
    const id = `guide:mechanic:${entry.category === 'Stat modifiers' ? 'stat' : 'ability'}:${encodeURIComponent(entry.name)}` as EntityId
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
  const caveatId = 'guide:mechanic:growth-and-damage' as EntityId
  const source = { ...MODDING_GUIDE_SOURCE, locator: 'Game synopsis > Growths; Abilities > Formula construction' }
  const formulaEntity: CatalogEntity = {
    id: caveatId, kind: 'other', name: 'Growth estimates and damage formula research', aliases: ['Stat calculator', 'Damage calculation', 'Growth formula'],
    rawDescription: 'Class details include a growth calculator using the guide equations and explicit growth allocations. Estimates retain fractions and exclude equipment, passives, and combat effects. Damage simulation requires resolving the formula discrepancies listed here.',
    fields: {
      Category: { state: 'known', value: ['Mechanics', 'Formulas'], sources: [source] },
      'Growth inputs': { state: 'known', value: ['Primary class ratings', 'Level', 'Levels allocated to each growth class', 'Explicit stat bonuses'], sources: [source] },
      'Unresolved damage details': { state: 'known', value: ['The variance description places variance before critical hits; the final pipeline reverses them', 'The guide uses UserPower + TargetPower in the reduction denominator; the developer post uses 2 * TargetPower', 'The guide does not specify all intermediate rounding and remaining multiplier order'], sources: [source] },
    }, sources: [source, { sourceId: 'https://steamcommunity.com/app/1637730/discussions/0/676199918678875437/', locator: 'Developer reply dated 2024-12-17', applicability: 'Published defense formula; discrepancy retained for investigation' }],
  }
  entities[caveatId] = formulaEntity
  const legacy = base.legacy && typeof base.legacy === 'object' && !Array.isArray(base.legacy) ? base.legacy : {}
  return {
    ...base, revisionId: CRYSTAL_EDIT_REVISION, checksum: CRYSTAL_EDIT_CHECKSUM, entities,
    legacy: { ...legacy, previousRevisionId: base.revisionId, crystalEditEvidence: { source: vanilla.source, guideSource: guide.source } as JsonValue },
  }
}
