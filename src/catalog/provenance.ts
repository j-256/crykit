import type { CatalogEntity } from '../domain/types'
import { STARTER_SOURCE_URLS } from './data'
import { SWITCH_CLASS_SOURCE, SWITCH_PASSIVE_PP_SOURCE } from './switch'

const FIXED_SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'crystal-edit:vanilla-class-copy': 'Crystal Edit vanilla class export',
  'community:geef-modding-guide': "GEEF's Crystal Project modding guide",
  [SWITCH_CLASS_SOURCE.sourceId]: 'Switch in-game confirmation',
  [SWITCH_PASSIVE_PP_SOURCE.sourceId]: 'Switch in-game PP confirmation',
  [STARTER_SOURCE_URLS['apworld-items']]: 'Base game names',
  [STARTER_SOURCE_URLS['apworld-classes']]: 'Base class names',
  [STARTER_SOURCE_URLS['apworld-monster-magic']]: 'Base Monster Magic names',
  [STARTER_SOURCE_URLS['equipment-expansion-sheet']]: 'Equipment Expansion',
  [STARTER_SOURCE_URLS['nintendo-mod-pack-2']]: 'Mod Pack 2 names',
  [STARTER_SOURCE_URLS['nintendo-mod-pack-1']]: 'Mod Pack 1 details',
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
  const mod = /^bundled-mod:([a-z0-9-]+):(.+)$/.exec(sourceId)
  if (mod) return `${mod[1]!.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ')} ${mod[2]} export`
  const native = /^native-game:windows:(\d+\.\d+\.\d+(?:\.\d+)?)$/.exec(sourceId)
  if (native) return `Windows ${native[1]} game files`
  const fixed = STARTER_SOURCE_LABELS[sourceId]
  if (fixed) return fixed
  try {
    const url = new URL(sourceId)
    if (url.hostname !== 'crystal-project.fandom.com') return undefined
    const page = url.pathname.split('/wiki/')[1]
    return page ? `Community wiki · ${decodeURIComponent(page).replaceAll('_', ' ')}` : 'Community wiki'
  } catch {
    return undefined
  }
}

export function starterEntitySourceLabel(entity: Pick<CatalogEntity, 'sources'>): string | undefined {
  const labels = Array.from(new Set(entity.sources
    .map((source) => starterSourceLabel(source.sourceId))
    .filter((label): label is string => label !== undefined)))
  return labels.length > 0 ? labels.join(' · ') : undefined
}
