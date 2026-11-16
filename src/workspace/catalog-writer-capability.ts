declare const __CRYKIT_COMPACT_CATALOG_QUALIFICATION__: boolean

// Production defines this literal false; only isolated synthetic builds can exercise the writer
// Elapsed release time and mutable browser state cannot establish old-device compatibility
export function compactCatalogWritersEnabled(): boolean {
  return typeof __CRYKIT_COMPACT_CATALOG_QUALIFICATION__ !== 'undefined' && __CRYKIT_COMPACT_CATALOG_QUALIFICATION__
}
export function requireCompactCatalogWriters(): void {
  if (!compactCatalogWritersEnabled()) throw new Error('Compact catalog writers are not enabled; keep the original backup and update the app')
}
