import { useState } from 'react'
import type { CatalogEntity } from '../domain/types'
import { catalogArtwork, wikiSprite, type CatalogArtwork as Artwork } from '../catalog/sprites'
import { Icon, type IconName } from './icons'

interface Props {
  readonly catalogId: string
  readonly entity: Pick<CatalogEntity, 'id' | 'kind' | 'name'>
  readonly detailed?: boolean
  readonly compact?: boolean
}

const COMPACT_SIZE = 48
const DETAIL_SIZE = 128
const MAX_WIKI_SCALE = 2
const MAX_NATIVE_SCALE = 4
const INLINE_SIZE = 28

const PLACEHOLDER_ICONS: Readonly<Record<CatalogEntity['kind'], IconName>> = Object.freeze({
  item: 'box',
  class: 'character',
  ability: 'spark',
  passive: 'spark',
  innate: 'spark',
  monsterMagic: 'spark',
  monster: 'character',
  command: 'menu',
  status: 'crystal',
  recipe: 'book',
  location: 'compass',
  other: 'crystal',
})

export function ArtworkPlaceholder({ entity, detailed = false, compact = false }: { readonly entity: Pick<CatalogEntity, 'kind' | 'name'>; readonly detailed?: boolean; readonly compact?: boolean }) {
  return <span aria-hidden={!detailed || undefined} aria-label={detailed ? `${entity.name} artwork placeholder` : undefined} className={`wiki-sprite wiki-sprite--placeholder${detailed ? ' wiki-sprite--detail' : ''}${compact ? ' wiki-sprite--compact' : ''}`} data-artwork-placeholder={entity.kind} role={detailed ? 'img' : undefined}><Icon name={PLACEHOLDER_ICONS[entity.kind]}/></span>
}

function ArtworkImage({ artwork, entity, detailed, compact }: { readonly artwork: Artwork; readonly entity: Props['entity']; readonly detailed: boolean; readonly compact: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <ArtworkPlaceholder compact={compact} detailed={detailed} entity={entity}/>
  const limit = compact ? INLINE_SIZE : detailed ? DETAIL_SIZE : COMPACT_SIZE
  const scale = Math.min(artwork.source === 'native' ? MAX_NATIVE_SCALE : MAX_WIKI_SCALE, limit / artwork.asset.width, limit / artwork.asset.height)
  const bounds = artwork.asset.contentBounds
  const offsetX = bounds ? artwork.asset.width / 2 - bounds.x - bounds.width / 2 : 0
  const offsetY = bounds ? artwork.asset.height / 2 - bounds.y - bounds.height / 2 : 0
  const style = offsetX || offsetY ? { transform: `translate(${offsetX / artwork.asset.width * 100}%, ${offsetY / artwork.asset.height * 100}%)` } : undefined
  return <span className={`wiki-sprite${detailed ? ' wiki-sprite--detail' : ''}${compact ? ' wiki-sprite--compact' : ''}`} data-artwork-source={artwork.source}><img alt={detailed ? `${entity.name} ${artwork.source === 'native' ? 'game' : 'wiki'} artwork` : ''} decoding="async" height={Math.round(artwork.asset.height * scale)} loading={detailed ? 'eager' : 'lazy'} onError={() => setFailed(true)} src={artwork.url} style={style} width={Math.round(artwork.asset.width * scale)}/></span>
}

export function CatalogArtwork({ catalogId, entity, detailed = false, compact = false }: Props) {
  const artwork = catalogArtwork(catalogId, entity)
  return artwork ? <ArtworkImage artwork={artwork} compact={compact} detailed={detailed} entity={entity} key={artwork.asset.file}/> : <ArtworkPlaceholder compact={compact} detailed={detailed} entity={entity}/>
}

export function ClassWorldArtwork({ catalogId, entity, detailed = false, compact = false }: Props) {
  const sprite = entity.kind === 'class' ? wikiSprite(catalogId, entity) : undefined
  const artwork: Artwork | undefined = sprite && { source: 'wiki', ...sprite }
  return artwork ? <ArtworkImage artwork={artwork} compact={compact} detailed={detailed} entity={entity} key={artwork.asset.file}/> : <ArtworkPlaceholder compact={compact} detailed={detailed} entity={entity}/>
}

export function CatalogArtworkSource({ catalogId, entity }: Props) {
  const artwork = catalogArtwork(catalogId, entity)
  if (!artwork) return <small className="wiki-sprite-missing">No exact artwork linked.</small>
  if (artwork.source === 'native') return <details className="wiki-sprite-source"><summary>Artwork source</summary><p>Extracted from the installed Windows game files.<br/>{artwork.asset.rights}</p><ul>{artwork.binding.identity.url ? <li><a href={artwork.binding.identity.url} rel="noreferrer" target="_blank">{artwork.binding.identity.upstreamName}</a> · pinned identity code {artwork.binding.identity.upstreamCode}</li> : <li>Reviewed item identity · <code>{artwork.binding.identity.locator}</code> · database fingerprint <code>{artwork.binding.identity.databaseSha256}</code></li>}<li><code>{artwork.binding.database.name}.dat</code> record {artwork.binding.database.id} · {artwork.binding.database.recordName}</li>{artwork.binding.rendering.sourceTextures.map((source, index) => <li key={`${source.texturePath}:${index}`}><code>{source.texturePath}</code> · crop {source.region.x},{source.region.y} {source.region.width}x{source.region.height}{source.field ? ` · ${source.field}` : ''}</li>)}</ul><p>Installed-content fingerprint: <code>{artwork.gameInputDigest}</code><br/>Executable fingerprint: <code>{artwork.executable.sha256}</code></p><p>This reflects the inspected Windows installation. Switch and mod-pack appearance is unverified.</p></details>
  return <details className="wiki-sprite-source"><summary>Artwork source</summary><p><a href={artwork.asset.descriptionUrl} rel="noreferrer" target="_blank">{artwork.asset.title.replace(/^File:/, '')}</a><br/>{artwork.asset.license}</p><ul>{artwork.binding.sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} rel="noreferrer" target="_blank">{source.title}</a> · {source.locator}</li>)}</ul><p>Community wiki artwork; Switch and mod-pack appearance is unverified.</p></details>
}
