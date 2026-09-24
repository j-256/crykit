import type { CatalogEntity } from '../domain/types'
import { STARTER_SOURCE_URLS } from './data'

const FIXED_SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [STARTER_SOURCE_URLS['apworld-items']]: 'Base game names',
  [STARTER_SOURCE_URLS['apworld-classes']]: 'Base class names',
  [STARTER_SOURCE_URLS['apworld-monster-magic']]: 'Base Monster Magic names',
  [STARTER_SOURCE_URLS['equipment-expansion-sheet']]: 'Equipment Expansion',
  [STARTER_SOURCE_URLS['nintendo-mod-pack-2']]: 'Mod Pack 2 names',
})

const WIKI_SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(STARTER_SOURCE_URLS)
    .filter(([key]) => key.startsWith('wiki-'))
    .map(([, sourceUrl]) => {
      const page = sourceUrl.split('/wiki/')[1]
      return [sourceUrl, `Community wiki · ${decodeURIComponent(page ?? '').replaceAll('_', ' ')}`]
    }),
))

const STARTER_SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ...FIXED_SOURCE_LABELS,
  ...WIKI_SOURCE_LABELS,
})

export function starterSourceLabel(sourceId: string): string | undefined {
  return STARTER_SOURCE_LABELS[sourceId]
}

export function starterEntitySourceLabel(entity: Pick<CatalogEntity, 'sources'>): string | undefined {
  const labels = Array.from(new Set(entity.sources
    .map((source) => starterSourceLabel(source.sourceId))
    .filter((label): label is string => label !== undefined)))
  return labels.length > 0 ? labels.join(' · ') : undefined
}
