export const OFFLINE_CONTENT_VERSION = 1
export const OFFLINE_CONTENT_MANIFEST = 'offline-content.json'

export const OFFLINE_EXTRAS = Object.freeze({
  artwork: { label: 'Artwork', detail: 'Bundled character, item and ability images. Placeholders work without this download.' },
  maps: { label: 'Maps', detail: 'World maps and terrain previews.' },
  screenshots: { label: 'Screenshot recognition', detail: 'Read Learn screenshots on this device without a connection.' },
})

export type OfflineExtra = keyof typeof OFFLINE_EXTRAS
export type OfflineContentId = 'core' | OfflineExtra

export interface OfflineContent {
  readonly id: OfflineContentId
  readonly files: number
  readonly bytes: number
  readonly ready: boolean
  readonly selected: boolean
}

export interface OfflineProgress {
  readonly completedFiles: number
  readonly totalFiles: number
  readonly completedBytes: number
  readonly totalBytes: number
}
