import { starterSourceLabel } from '../catalog/provenance'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, CRYSTAL_EDIT_SCHEMA_SOURCE } from '../domain/crystal-edit'
import { NATIVE_RECORD_FIELD, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import type { CatalogEntity, Knowledge, SourceRef } from '../domain/types'

const EXPORT_INTERNAL_FIELDS = new Set([NATIVE_RECORD_FIELD, CLASS_FIELDS.tree, CLASS_FIELDS.abilities, CLASS_FIELDS.passives, CRYSTAL_EDIT_FIELDS.tree, CRYSTAL_EDIT_FIELDS.abilities, CRYSTAL_EDIT_FIELDS.passives, 'Crystal Edit copied job ID', 'Crystal Edit model ID', 'Crystal Edit model type', 'Crystal Edit source record'])
const SECONDARY_GROWTH_FIELDS = new Set([CRYSTAL_EDIT_FIELDS.ratings, 'Stat growth'])
const FACT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [CLASS_FIELDS.ratings]: 'Growth ratings',
  [CLASS_FIELDS.equipment]: 'Equipment permissions',
  [CRYSTAL_EDIT_FIELDS.ratings]: 'Growth ratings',
  [CRYSTAL_EDIT_FIELDS.equipment]: 'Equipment permissions',
  [CRYSTAL_EDIT_FIELDS.command]: 'Class command',
  'Crystal Edit crystal name': 'Crystal name',
})

export function isGameExportSource(source: SourceRef): boolean {
  const importedProject = source.snapshot?.startsWith('Crystal Edit ') && /^\/(?:Jobs|Abilities|Passives|Equipment|Items|Monsters|Statuses|Recipes|Biomes)\/\d+$/.test(source.locator ?? '')
  return Boolean(importedProject) || source.sourceId.startsWith(NATIVE_SOURCE_PREFIX) || source.sourceId.startsWith('game-export:') || source.sourceId.startsWith('crystal-edit-export:') || source.sourceId === 'crystal-edit:vanilla-class-copy' || source.sourceId === CRYSTAL_EDIT_SCHEMA_SOURCE.sourceId
}

export function visibleSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return sources.filter(source => !isGameExportSource(source))
}

export function definitionFactLabel(field: string): string {
  return FACT_LABELS[field] ?? field
}

export function visibleDefinitionFacts(entity: Pick<CatalogEntity, 'fields'>, editing = false): readonly (readonly [string, Knowledge<unknown>])[] {
  const nativeRatings = entity.fields[CLASS_FIELDS.ratings]
  const nativeSource = Object.values(entity.fields).some(value => value.state === 'known' && value.sources?.some(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX)))
  return Object.entries(entity.fields).filter(([field, value]) => {
    if (editing) return true
    if (EXPORT_INTERNAL_FIELDS.has(field) && value.state === 'known') return false
    if (nativeSource && ['Game platform', 'Game version', 'Mode data'].includes(field) && value.state === 'known') return false
    return nativeRatings?.state !== 'known' || !SECONDARY_GROWTH_FIELDS.has(field)
  })
}

export interface SourceDisplay {
  readonly label: string
  readonly detail?: string
}

function urlHost(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

export function sourceDisplay(value: string): SourceDisplay {
  const label = starterSourceLabel(value)
  const host = urlHost(value)
  if (label) return { label, ...(host ? { detail: host } : {}) }
  if (host) return { label: host, detail: value }
  return { label: value }
}
