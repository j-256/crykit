import { useContext, useState } from 'react'
import { entityDefinitionKey } from '../domain/core'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, EntityRef, LocalData } from '../domain/types'
import { catalogArtwork, menuIcon, type MenuIcon } from '../catalog/sprites'
import { definitionIconKey, fieldIconKeys } from '../catalog/menu-icons'
import { resolveDefinition } from '../domain/definitions'
import { ArtworkPlaceholder, CatalogArtwork } from './WikiSprite'
import { LocalArtworkContext } from './mods/PrivateArtwork'
import { Sources } from './Sources'

const ICON_SIZE = 24
const CLASS_ICON_FIELDS = [[CLASS_FIELDS.command, 'Command'], [CRYSTAL_EDIT_FIELDS.command, 'Command']] as const
export { LocalArtworkContext } from './mods/PrivateArtwork'

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

function LocalDefinitionImage({ url }: { readonly url: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? <ArtworkPlaceholder compact entity={{ kind: 'other', name: 'Local artwork unavailable' }}/> : <img alt="" className="game-icon" decoding="async" height={ICON_SIZE} onError={() => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); setFailed(true) }} src={url} width={ICON_SIZE}/>
}

export function DefinitionArtwork({ localData, catalogs, value, compact = true }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; value?: EntityRef | null; compact?: boolean }) {
  const localArtwork = useContext(LocalArtworkContext)
  if (!value) return null
  const localImage = localArtwork[entityDefinitionKey(value)]
  if (localImage) return <LocalDefinitionImage key={localImage} url={localImage}/>
  const entity = resolveDefinition(localData, catalogs, value)
  if (!entity) return <ArtworkPlaceholder compact={compact} entity={{ kind: 'other', name: 'Unresolved definition' }}/>
  if (value.kind === 'catalog') {
    const artworkEntity = { ...entity, id: value.entityId }
    if (catalogArtwork(value.catalogId, artworkEntity) || entity.fields['Source mod project ID']) return <CatalogArtwork catalogId={value.catalogId} catalogRevisionId={value.catalogRevisionId} compact={compact} entity={artworkEntity}/>
  }
  const iconKey = definitionIconKey(entity)
  if (iconKey) return <GameIcon iconKey={iconKey} placeholderKind={entity.kind}/>
  return <ArtworkPlaceholder compact={compact} entity={entity}/>
}

function externalFieldIconKeys(fields: CatalogEntity['fields']): readonly string[] {
  const keys = new Set(fieldIconKeys(fields))
  // Credits follow the same command and equipment facts when native or mod fields supply their display values
  for (const [field, label] of CLASS_ICON_FIELDS) {
    const value = fields[field]
    if (value) for (const key of fieldIconKeys({ [label]: value })) keys.add(key)
  }
  return [...keys].filter(key => menuIcon(key)?.provenance === 'supplemental-source')
}

export function hasExternalFieldIcons(fields: CatalogEntity['fields']): boolean {
  return externalFieldIconKeys(fields).length > 0
}

export function FieldIconSources({ fields }: { fields: CatalogEntity['fields'] }) {
  const keys = externalFieldIconKeys(fields)
  if (!keys.length) return null
  return <Sources label="Sources for menu icons"><ul>{keys.map(key => {
    const icon = menuIcon(key)!
    return <li key={key}>{icon.asset.descriptionUrl ? <a href={icon.asset.descriptionUrl} rel="noreferrer" target="_blank">{icon.binding.name}</a> : icon.binding.name} · {icon.asset.license}<ul>{icon.binding.sources.map((source, index) => <li key={`${source.url ?? source.locator}:${index}`}>{source.url ? <a href={source.url} rel="noreferrer" target="_blank">{source.title}</a> : source.title} · {source.locator}</li>)}</ul></li>
  })}</ul></Sources>
}
