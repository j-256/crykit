import { useState } from 'react'
import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, EntityRef, LocalData } from '../domain/types'
import { menuIcon, type MenuIcon } from '../catalog/sprites'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import { definitionIconKey, fieldIconKeys } from '../catalog/menu-icons'
import { resolveDefinition } from '../domain/definitions'
import { ArtworkPlaceholder, WikiSprite } from './WikiSprite'

const ICON_SIZE = 24

function IconImage({ icon, iconKey, placeholderKind = 'other' }: { icon: MenuIcon; iconKey: string; placeholderKind?: CatalogEntityKind }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <ArtworkPlaceholder compact entity={{ kind: placeholderKind, name: icon.binding.name }}/>
  const region = icon.binding.region
  const width = region?.width ?? icon.asset.width
  const height = region?.height ?? icon.asset.height
  const scale = Math.min(ICON_SIZE / width, ICON_SIZE / height)
  return <span aria-hidden="true" className="game-icon" data-game-icon={iconKey} title={`${icon.binding.name} icon`}>
    <span className="game-icon__crop" style={{ width: width * scale, height: height * scale }}><img alt="" decoding="async" draggable={false} height={icon.asset.height * scale} onError={() => setFailed(true)} src={icon.url} style={{ left: -(region?.x ?? 0) * scale, top: -(region?.y ?? 0) * scale }} width={icon.asset.width * scale}/></span>
  </span>
}

export function GameIcon({ iconKey, placeholderKind }: { iconKey?: string; placeholderKind?: CatalogEntityKind }) {
  const icon = iconKey ? menuIcon(iconKey) : undefined
  return icon && iconKey ? <IconImage icon={icon} iconKey={iconKey} key={`${iconKey}:${icon.asset.file}`} placeholderKind={placeholderKind}/> : null
}

export function DefinitionArtwork({ localData, catalogs, value }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; value?: EntityRef | null }) {
  if (!value) return null
  const entity = resolveDefinition(localData, catalogs, value)
  if (!entity) return <ArtworkPlaceholder compact entity={{ kind: 'other', name: 'Unresolved definition' }}/>
  const iconKey = definitionIconKey(entity)
  if (iconKey) return <GameIcon iconKey={iconKey} placeholderKind={entity.kind}/>
  if (value.kind !== 'catalog' || value.catalogId !== STARTER_CATALOG_ID) return <ArtworkPlaceholder compact entity={entity}/>
  return <WikiSprite catalogId={value.catalogId} compact entity={{ id: value.entityId, kind: entity.kind, name: entity.name }}/>
}

export function FieldIconSources({ fields }: { fields: CatalogEntity['fields'] }) {
  const keys = fieldIconKeys(fields)
  if (!keys.length) return null
  return <details className="menu-icon-sources"><summary>Menu icon sources</summary><ul>{keys.map(key => {
    const icon = menuIcon(key)!
    return <li key={key}><a href={icon.asset.descriptionUrl} rel="noreferrer" target="_blank">{icon.binding.name}</a> · {icon.asset.license}{icon.binding.region && ' · Region of a public equipment-menu image'}</li>
  })}</ul></details>
}
