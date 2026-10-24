import type { JsonValue, ModLayer, ModSourceReceipt } from '../domain/types'
import type { JsonPath } from '../mod-inspector/types'

export interface BlobSource { readonly byteLength: number; open(): AsyncIterable<Uint8Array> }
export interface WorkspaceBlobRef {
  readonly documentId: string
  readonly revisionId: string
  readonly byteLength: number
  readonly sha256: string
  readonly encoding: 'bytes' | 'utf8' | 'utf16le'
}
export interface EditorWorkspaceDocument {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly filename: string
  readonly referenceId: string
  readonly original: WorkspaceBlobRef
  readonly originalByteIdentity: 'exact' | 'text-only'
  readonly lastApplied: WorkspaceBlobRef
  readonly unfinished: { readonly text: WorkspaceBlobRef; readonly editedPath: JsonPath; readonly fieldState: JsonValue; readonly baseRevision: number; readonly validation: 'valid' | 'invalid' | 'unchecked' }
  readonly createdAt: string
  readonly updatedAt: string
}
export interface SaveWorkspaceDocument {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly filename: string
  readonly original: WorkspaceBlobRef
  readonly working: WorkspaceBlobRef
  readonly pendingForm: JsonValue
  readonly requirements: readonly ModSourceReceipt[]
  readonly coverage: { readonly status: 'supported' | 'unsupported'; readonly codecVersion?: string; readonly diagnostics: readonly string[] }
  readonly createdAt: string
  readonly updatedAt: string
  readonly exportedRevision: number | null
}
export interface WorkspaceAsset {
  readonly version: 1
  readonly id: string
  readonly sourceKey: string
  readonly relativePath: string
  readonly original: WorkspaceBlobRef
  readonly thumbnail?: WorkspaceBlobRef
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly width: number
  readonly height: number
}
export interface LibraryDefaults { readonly version: 1; readonly layers: readonly ModLayer[] }
