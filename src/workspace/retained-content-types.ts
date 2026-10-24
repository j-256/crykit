import type { WorkspaceConflictAncestor, WorkspaceConflictClosure, WorkspaceConflictUnit } from './conflict-types'

export type WorkspaceRetainedContent =
  | { readonly version: 1; readonly kind: 'file-history'; readonly id: string; readonly fileKind: 'editor' | 'save'; readonly documentId: string; readonly retainedAt: string; readonly retention: 'protected' | 'autosave-recovery'; readonly content: WorkspaceConflictClosure }
  | { readonly version: 1; readonly kind: 'pending-content'; readonly id: string; readonly groupId: string; readonly unit: WorkspaceConflictUnit; readonly base: WorkspaceConflictAncestor; readonly target: WorkspaceConflictClosure }
