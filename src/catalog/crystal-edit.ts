import vanilla from './vanilla-jobs.json' with { type: 'json' }
import { classFields } from '../domain/crystal-edit'
import type { CatalogSnapshot, SourceRef } from '../domain/types'

export const VANILLA_CLASS_SOURCE: SourceRef = vanilla.source

export function addCrystalEditFacts(base: CatalogSnapshot): CatalogSnapshot {
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
  return { ...base, entities }
}
