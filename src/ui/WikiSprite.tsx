import { useState } from 'react'
import type { CatalogEntity } from '../domain/types'
import { wikiSprite, type WikiSprite as Sprite } from '../catalog/sprites'

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

function SpriteImage({ sprite, name, detailed, compact }: { readonly sprite: Sprite; readonly name: string; readonly detailed: boolean; readonly compact: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return detailed ? <small>Artwork unavailable</small> : null
  const limit = compact ? INLINE_SIZE : detailed ? DETAIL_SIZE : COMPACT_SIZE
  const scale = Math.min(MAX_SCALE, limit / sprite.asset.width, limit / sprite.asset.height)
  return <span className={`wiki-sprite${detailed ? ' wiki-sprite--detail' : ''}${compact ? ' wiki-sprite--compact' : ''}`}><img alt={detailed ? `${name} wiki artwork` : ''} decoding="async" height={Math.round(sprite.asset.height * scale)} loading={detailed ? 'eager' : 'lazy'} onError={() => setFailed(true)} src={sprite.url} width={Math.round(sprite.asset.width * scale)}/></span>
}

export function WikiSprite({ catalogId, entity, detailed = false, compact = false }: Props) {
  const sprite = wikiSprite(catalogId, entity)
  return sprite ? <SpriteImage compact={compact} detailed={detailed} key={sprite.asset.file} name={entity.name} sprite={sprite}/> : null
}

export function WikiSpriteSource({ catalogId, entity }: Props) {
  const sprite = wikiSprite(catalogId, entity)
  if (!sprite) return <small className="wiki-sprite-missing">No wiki artwork linked.</small>
  return <details className="wiki-sprite-source"><summary>Artwork source</summary><p><a href={sprite.asset.descriptionUrl} rel="noreferrer" target="_blank">{sprite.asset.title.replace(/^File:/, '')}</a><br/>{sprite.asset.license}</p><ul>{sprite.binding.sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} rel="noreferrer" target="_blank">{source.title}</a> · {source.locator}</li>)}</ul><p>Community wiki artwork; Switch and mod-pack appearance is unverified.</p></details>
}
