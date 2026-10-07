import { useEffect, useMemo, useState } from 'react'
import { loadMapGeometryTile } from '../../catalog/world-map'
import { MAP_GEOMETRY, type MapGeometryTile } from '../../domain/map-geometry'
import type { WorldMapManifest } from '../../domain/world-map'
import { isoVisibleGeometryTiles, type IsoCamera } from '../../mod-inspector/isometric'

export function useMapGeometry(manifest: WorldMapManifest, layerId: number, camera: IsoCamera, active: boolean, attempt: number) {
  const candidates = useMemo(() => isoVisibleGeometryTiles(manifest.layers.find(layer => layer.id === layerId)?.geometry ?? [], camera), [manifest, layerId, camera])
  const membership = candidates.map(tile => tile.file).sort().join(',')
  // Camera motion inside the same tile set must not restart a download batch
  // Distance order only schedules the first request when membership changes
  const requested = useMemo(() => candidates, [membership, manifest, layerId])
  const [tiles, setTiles] = useState<readonly MapGeometryTile[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!active) { setPending(false); return }
    let cancelled = false
    let index = 0
    const loaded: MapGeometryTile[] = []
    setPending(requested.length > 0); setError('')
    const download = async () => {
      while (!cancelled && index < requested.length) {
        const tile = requested[index++]!
        loaded.push(await loadMapGeometryTile(tile, layerId))
      }
    }
    // A stale viewport stops scheduling after its in-flight requests drain
    // Loading is bounded separately from the shared decoded-tile LRU cache
    void Promise.allSettled(Array.from({ length: MAP_GEOMETRY.downloads }, download)).then(results => {
      if (cancelled) return
      const failure = results.find(result => result.status === 'rejected')
      setTiles(loaded); setPending(false)
      if (failure?.status === 'rejected') setError(failure.reason instanceof Error ? failure.reason.message : 'Native geometry could not be loaded.')
    })
    return () => { cancelled = true }
  }, [requested, layerId, active, attempt])
  const layerTiles = useMemo(() => tiles.filter(tile => tile.layer === layerId), [tiles, layerId])
  return { tiles: layerTiles, pending, error }
}
