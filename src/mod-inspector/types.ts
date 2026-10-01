export type JsonPath = readonly (string | number)[]
export type JsonNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export interface JsonNode {
  readonly kind: JsonNodeKind
  readonly path: JsonPath
  readonly start: number
  readonly end: number
  readonly raw: string
  readonly key?: string
  readonly value?: string | boolean | null
  readonly children: readonly JsonNode[]
}

export interface ParsedDocument {
  readonly text: string
  readonly root: JsonNode
  readonly nodeCount: number
}

export interface DocumentChange {
  readonly kind: 'added' | 'removed' | 'changed' | 'moved'
  readonly path: JsonPath
  readonly beforePath?: JsonPath
  readonly group: string
  readonly before?: JsonNode
  readonly after?: JsonNode
}

export interface LookupOption {
  readonly value: string
  readonly label: string
  readonly detail?: string
  readonly provenance?: string
  readonly source: 'enum' | 'mod' | 'base'
  readonly path?: JsonPath
}

export interface FieldAnnotation {
  readonly kind: 'enum' | 'reference' | 'parameter' | 'identity' | 'metadata'
  readonly label: string
  readonly detail?: string
  readonly provenance?: string
  readonly status: 'resolved' | 'unknown' | 'ambiguous' | 'unused'
  readonly targetPath?: JsonPath
  readonly restrictions?: readonly string[]
}

export interface InspectorIssue {
  readonly path: JsonPath
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
}

export interface InspectorRelationship {
  readonly path: JsonPath
  readonly targetPath?: JsonPath
  readonly label: string
  readonly direction: 'incoming' | 'outgoing'
  readonly unresolved?: boolean
}

export interface EnumCatalog {
  readonly name: string
  readonly entries: readonly LookupOption[]
}

export interface EditorVersionInfo {
  readonly state: 'matched' | 'older' | 'newer' | 'missing' | 'invalid'
  readonly value?: string
  readonly referenceVersion: number
  readonly label: string
  readonly detail: string
}

export interface InspectorResolver {
  readonly editorVersion: EditorVersionInfo
  readonly sourceLabel: string
  readonly referenceId: string
  readonly issues: readonly InspectorIssue[]
  annotate(path: JsonPath): FieldAnnotation | undefined
  options(path: JsonPath): readonly LookupOption[]
  relationships(path: JsonPath): readonly InspectorRelationship[]
}

export type InspectorFileInfoState = 'present' | 'missing' | 'invalid'

export interface InspectorFileInfo {
  readonly schemaVersion: 1
  readonly title?: string
  readonly version?: string
  readonly projectId?: string
  readonly titleState: InspectorFileInfoState
  readonly versionState: InspectorFileInfoState
  readonly projectIdState: InspectorFileInfoState
  readonly edited: boolean
}

export interface InspectorDraft {
  readonly schemaVersion: 1
  readonly id: string
  readonly filename: string
  readonly fileInfo?: InspectorFileInfo
  readonly originalText: string
  readonly draftText: string
  readonly referenceId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
}

export type InspectorDraftSummary = Pick<InspectorDraft, 'schemaVersion' | 'id' | 'filename' | 'referenceId' | 'createdAt' | 'updatedAt' | 'revision' | 'fileInfo'>
