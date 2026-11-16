import type { CatalogEntity } from '../domain/types'

export function starterSourceLabel(sourceId: string): string | undefined {
  const mod = /^bundled-mod:([a-z0-9-]+):(.+)$/.exec(sourceId)
  if (mod) return `${mod[1]!.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ')} ${mod[2]} export`
  const native = /^native-game:windows:(\d+\.\d+\.\d+(?:\.\d+)?)$/.exec(sourceId)
  if (native) return `Windows ${native[1]} game files`
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
