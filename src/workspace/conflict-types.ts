import type { WorkspaceBlobRef } from './file-types'
import type { WorkspaceDocumentKind } from './documents'

export type WorkspaceConflictUnit = { readonly kind: 'record'; readonly privateKey: string } | { readonly kind: 'directory-mapping'; readonly privateKey: string; readonly shard: number }
export interface WorkspaceConflictClosure { readonly version: 1; readonly root: WorkspaceBlobRef; readonly index: WorkspaceBlobRef }
export type WorkspaceConflictAncestor = { readonly kind: 'present'; readonly closure: WorkspaceConflictClosure } | { readonly kind: 'absent' }
export interface WorkspaceConflictBranch { readonly role: 'local-pending' | 'accepted-cloud'; readonly closure: WorkspaceConflictClosure }
export type WorkspaceConflictDisposition = { readonly kind: 'unresolved' } | { readonly kind: 'resolved'; readonly choice: 'this' | 'other' | 'both'; readonly result: WorkspaceConflictClosure }
export interface WorkspaceConflict {
  readonly version: 1
  readonly id: string
  readonly unit: WorkspaceConflictUnit
  readonly commonAncestor: WorkspaceConflictAncestor
  readonly branches: readonly [WorkspaceConflictBranch, WorkspaceConflictBranch]
  readonly disposition: WorkspaceConflictDisposition
}
export interface WorkspaceConflictClosureEntry {
  readonly version: 1
  readonly ref: WorkspaceBlobRef
  readonly documentVersion: 1
  readonly kind: WorkspaceDocumentKind
  readonly key: string
  readonly encoding: 'json' | 'bytes'
  readonly dependencies: readonly WorkspaceBlobRef[]
  readonly retainingIndex?: WorkspaceBlobRef
}
export interface WorkspaceConflictClosurePage {
  readonly version: 1
  readonly kind: 'conflict-closure-page'
  readonly entries: readonly WorkspaceConflictClosureEntry[]
  readonly children: readonly WorkspaceBlobRef[]
}
export interface WorkspaceDirectoryConflictUnit {
  readonly version: 1
  readonly kind: 'directory-mapping-unit'
  readonly privateKey: string
  readonly shard: number
  readonly shardEvidence: WorkspaceBlobRef
  readonly allocation: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly sourceDocumentId: string; readonly valueRoot: WorkspaceBlobRef }
}
