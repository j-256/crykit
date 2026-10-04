import { starterSourceLabel } from '../catalog/provenance'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, CRYSTAL_EDIT_SCHEMA_SOURCE } from '../domain/crystal-edit'
import { NATIVE_RECORD_FIELD, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import type { CatalogEntity, Knowledge, SourceRef } from '../domain/types'

const EXPORT_INTERNAL_FIELDS = new Set([NATIVE_RECORD_FIELD, CLASS_FIELDS.tree, CLASS_FIELDS.abilities, CLASS_FIELDS.passives, CRYSTAL_EDIT_FIELDS.tree, CRYSTAL_EDIT_FIELDS.abilities, CRYSTAL_EDIT_FIELDS.passives, 'Crystal Edit copied job ID', 'Crystal Edit model ID', 'Crystal Edit model type', 'Crystal Edit source record'])
const GAME_EXPORT_SOURCE_IDS = new Set(['crystal-edit:vanilla-class-copy', 'crystal-project:pc-class-tree-identities', CRYSTAL_EDIT_SCHEMA_SOURCE.sourceId])
const NATIVE_GAME_SOURCE_ID = /^native-game:windows:\d+\.\d+\.\d+(?:\.\d+)?$/
const SECONDARY_CLASS_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  [CRYSTAL_EDIT_FIELDS.ratings]: CLASS_FIELDS.ratings,
  [CRYSTAL_EDIT_FIELDS.equipment]: CLASS_FIELDS.equipment,
  [CRYSTAL_EDIT_FIELDS.command]: CLASS_FIELDS.command,
  'Stat growth': CLASS_FIELDS.ratings,
  'Growth ratings': CLASS_FIELDS.ratings,
  'Equipment Types': CLASS_FIELDS.equipment,
  'Abilities Name': CLASS_FIELDS.command,
  'Crystal Edit crystal name': 'Crystal name',
  'Crystal Name': 'Crystal name',
  'Is Starting Job': 'Available as a starting class',
  'Is Unselectable Job': 'Primary class selection disabled',
  'Is Unselectable Sub Job': 'Secondary class selection disabled',
  'Is Not Crystal Job': 'Excluded from crystal count',
})
const LONG_FACT_LENGTH = 160
const EDITOR_PRESENTATION_FIELD = /^(Hide .+ From Description|Invert .+ Display)$/
const FACT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'Max hp': 'Max HP',
  'Max mp': 'Max MP',
  [CLASS_FIELDS.ratings]: 'Growth ratings',
  [CLASS_FIELDS.equipment]: 'Equipment permissions',
  [CRYSTAL_EDIT_FIELDS.ratings]: 'Growth ratings',
  [CRYSTAL_EDIT_FIELDS.equipment]: 'Equipment permissions',
  [CRYSTAL_EDIT_FIELDS.command]: 'Class command',
  'Crystal Edit crystal name': 'Crystal name',
})

export function isGameExportSource(source: SourceRef): boolean {
  const importedProject = source.snapshot?.startsWith('Crystal Edit ') && /^\/(?:Jobs|Abilities|Passives|Equipment|Items|Monsters|Statuses|Recipes|Biomes)\/\d+$/.test(source.locator ?? '')
  return Boolean(importedProject) || source.sourceId.startsWith('bundled-mod:') || source.sourceId.startsWith(NATIVE_SOURCE_PREFIX) || source.sourceId.startsWith('game-export:') || source.sourceId.startsWith('crystal-edit-export:') || GAME_EXPORT_SOURCE_IDS.has(source.sourceId)
}

export function visibleSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return externalSources(sources)
}

export function isNativeGameSource(source: SourceRef): boolean {
  return NATIVE_GAME_SOURCE_ID.test(source.sourceId)
}

export function externalSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return sources.filter(source => !isNativeGameSource(source))
}

export function definitionFactLabel(field: string, value?: Knowledge<unknown>, fields: readonly string[] = []): string {
  if (field === 'Learning cost' && value?.state === 'known' && typeof value.value === 'number') return 'Learning cost (LP)'
  const imported = /^(Table|Section): (.+)$/.exec(field)
  if (!imported) return FACT_LABELS[field] ?? field
  const label = imported[2]!
  if (imported[1] === 'Table' && value) {
    const sources = value.state === 'conflicting' ? value.claims.flatMap(claim => claim.sources) : value.state === 'notApplicable' ? [] : value.sources ?? []
    for (const source of sources) {
      const section = source.locator?.split(' > ').at(-1)
      if (!section || !label.startsWith(`${section} `) || fields.includes(`Table: ${section}`)) continue
      const counter = label.slice(section.length + 1)
      if (/^\d+$/.test(counter) && Number(counter) >= 2) return section
    }
  }
  return label
}

export function definitionFactIsWide(field: string, value: Knowledge<unknown>): boolean {
  if (value.state === 'conflicting' || /^(Table|Section): /.test(field)) return true
  if (value.state !== 'known') return false
  if (typeof value.value === 'string') return value.value.length > LONG_FACT_LENGTH || value.value.includes('\n')
  if (Array.isArray(value.value)) return value.value.some(entry => entry !== null && typeof entry === 'object')
  return value.value !== null && typeof value.value === 'object'
}

export function visibleDefinitionFacts(entity: Pick<CatalogEntity, 'fields'>, editing = false): readonly (readonly [string, Knowledge<unknown>])[] {
  const nativeSource = Object.values(entity.fields).some(value => value.state === 'known' && value.sources?.some(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX)))
  const gameRecord = entity.fields[NATIVE_RECORD_FIELD]?.state === 'known' || entity.fields['Crystal Edit source record']?.state === 'known'
  return Object.entries(entity.fields).filter(([field, value]) => {
    if (editing) return true
    if (EXPORT_INTERNAL_FIELDS.has(field) && value.state === 'known') return false
    if (gameRecord && (EDITOR_PRESENTATION_FIELD.test(field) || field === 'JP' && entity.fields['Learning cost']?.state === 'known')) return false
    if (nativeSource && ['Game platform', 'Game version', 'Mode data'].includes(field) && value.state === 'known') return false
    const preferred = SECONDARY_CLASS_FIELDS[field]
    return !preferred || entity.fields[preferred]?.state !== 'known'
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
