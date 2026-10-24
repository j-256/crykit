import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CatalogEntity } from '../../domain/types'
import { findPrivateArtworkForEntity, openLocalArtwork, openPrivateArtwork, privateArtworkRegion } from '../../workspace/artwork-repository'
import { useOptionalWorkspace } from '../WorkspaceProvider'

export const LocalArtworkContext = createContext<Readonly<Record<string, string>>>({})

export function PrivateArtwork({ catalogId, catalogRevisionId, entity, detailed = false, compact = false, fallback }: { readonly catalogId: string; readonly catalogRevisionId?: string; readonly entity: Pick<CatalogEntity, 'id' | 'kind' | 'name' | 'fields'>; readonly detailed?: boolean; readonly compact?: boolean; readonly fallback: ReactNode }) {
  const workspace = useOptionalWorkspace()
  const local = useContext(LocalArtworkContext)
  const localKey = catalogRevisionId ? JSON.stringify(['catalog', catalogId, catalogRevisionId, entity.id]) : undefined
  const localUrl = localKey ? local[localKey] : undefined
  const entityIdentity = JSON.stringify([entity.id, entity.kind, entity.fields['Crystal Edit source record'], entity.fields['Crystal Edit model type'], entity.fields['Source mod project ID']])
  const [opened, setOpened] = useState<{ url: string; revoke: () => void; region: { x: number; y: number; width: number; height: number }; width: number; height: number; guest: boolean }>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!workspace || localUrl) return
    let live = true
    let release: (() => void) | undefined
    setOpened(undefined)
    setFailed(false)
    void (async () => {
      const state = await workspace.repository.readWorkspace()
      if (!live) return
      const asset = findPrivateArtworkForEntity(state, catalogId, entity, catalogRevisionId)
      if (!asset) return
      const region = privateArtworkRegion(entity, asset)
      if (!region) return
      const image = workspace.token ? await openPrivateArtwork(workspace.token, asset.id) : await openLocalArtwork(workspace.repository, asset.id)
      if (!live) { image.revoke(); return }
      release = image.revoke
      setOpened({ ...image, region, width: asset.width, height: asset.height, guest: !workspace.token })
    })().catch(() => { if (live) setFailed(true) })
    return () => { live = false; release?.() }
  }, [workspace?.repository, workspace?.token, catalogId, catalogRevisionId, entityIdentity, localUrl])
  if (localUrl) return <img alt={detailed ? `${entity.name} local artwork` : ''} className="game-icon" decoding="async" src={localUrl}/>
  if (!opened || failed) return fallback
  const limit = compact ? 28 : detailed ? 128 : 48
  const scale = Math.min(4, limit / opened.region.width, limit / opened.region.height)
  return <span className={`wiki-sprite${detailed ? ' wiki-sprite--detail' : ''}${compact ? ' wiki-sprite--compact' : ''}`} data-artwork-source="private" title={opened.guest ? 'Local artwork' : 'Private artwork'}>{opened.guest && detailed && <small>Local artwork</small>}<span className="wiki-sprite__crop" style={{ width: Math.round(opened.region.width * scale), height: Math.round(opened.region.height * scale) }}><img alt={detailed ? `${entity.name} private artwork` : ''} decoding="async" draggable={false} onError={() => { opened.revoke(); setFailed(true) }} src={opened.url} style={{ width: opened.width * scale, height: opened.height * scale, left: -opened.region.x * scale, top: -opened.region.y * scale }}/></span></span>
}
