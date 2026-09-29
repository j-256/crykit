import { useState } from 'react'
import type { CatalogEntity } from '../domain/types'
import { wikiSprite, type WikiSprite as Sprite } from '../catalog/sprites'
import { Icon, type IconName } from './icons'

interface Props {
  readonly catalogId: string
  readonly entity: Pick<CatalogEntity, 'id' | 'kind' | 'name'>
  readonly detailed?: boolean
  readonly compact?: boolean
}

const COMPACT_SIZE = 48
const DETAIL_SIZE = 128
const MAX_SCALE = 2
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

function SpriteImage({ sprite, entity, detailed, compact }: { readonly sprite: Sprite; readonly entity: Props['entity']; readonly detailed: boolean; readonly compact: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <ArtworkPlaceholder compact={compact} detailed={detailed} entity={entity}/>
  const limit = compact ? INLINE_SIZE : detailed ? DETAIL_SIZE : COMPACT_SIZE
  const scale = Math.min(MAX_SCALE, limit / sprite.asset.width, limit / sprite.asset.height)
  const bounds = sprite.asset.contentBounds
  const offsetX = bounds ? sprite.asset.width / 2 - bounds.x - bounds.width / 2 : 0
  const offsetY = bounds ? sprite.asset.height / 2 - bounds.y - bounds.height / 2 : 0
  const style = offsetX || offsetY ? { transform: `translate(${offsetX / sprite.asset.width * 100}%, ${offsetY / sprite.asset.height * 100}%)` } : undefined
  return <span className={`wiki-sprite${detailed ? ' wiki-sprite--detail' : ''}${compact ? ' wiki-sprite--compact' : ''}`}><img alt={detailed ? `${entity.name} wiki artwork` : ''} decoding="async" height={Math.round(sprite.asset.height * scale)} loading={detailed ? 'eager' : 'lazy'} onError={() => setFailed(true)} src={sprite.url} style={style} width={Math.round(sprite.asset.width * scale)}/></span>
}

export function WikiSprite({ catalogId, entity, detailed = false, compact = false }: Props) {
  const sprite = wikiSprite(catalogId, entity)
  return sprite ? <SpriteImage compact={compact} detailed={detailed} entity={entity} key={sprite.asset.file} sprite={sprite}/> : <ArtworkPlaceholder compact={compact} detailed={detailed} entity={entity}/>
}

export function WikiSpriteSource({ catalogId, entity }: Props) {
  const sprite = wikiSprite(catalogId, entity)
  if (!sprite) return <small className="wiki-sprite-missing">No wiki artwork linked.</small>
  return <details className="wiki-sprite-source"><summary>Artwork source</summary><p><a href={sprite.asset.descriptionUrl} rel="noreferrer" target="_blank">{sprite.asset.title.replace(/^File:/, '')}</a><br/>{sprite.asset.license}</p><ul>{sprite.binding.sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} rel="noreferrer" target="_blank">{source.title}</a> · {source.locator}</li>)}</ul><p>Community wiki artwork; Switch and mod-pack appearance is unverified.</p></details>
}
