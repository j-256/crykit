import { objectProperty } from './document'
import type { InspectorFileInfo, InspectorFileInfoState, ParsedDocument } from './types'

export const INSPECTOR_FILE_INFO_SCHEMA_VERSION = 1
export const INSPECTOR_FILE_INFO_TEXT_LIMIT = 160

const FIELDS = Object.freeze([
  ['Title', 'title', 'titleState'],
  ['Version', 'version', 'versionState'],
  ['ID', 'projectId', 'projectIdState'],
] as const)

export function deriveInspectorFileInfo(document: ParsedDocument, edited: boolean): InspectorFileInfo {
  const info: { schemaVersion: 1; edited: boolean; title?: string; version?: string; projectId?: string; titleState: InspectorFileInfoState; versionState: InspectorFileInfoState; projectIdState: InspectorFileInfoState } = {
    schemaVersion: INSPECTOR_FILE_INFO_SCHEMA_VERSION, edited, titleState: 'missing', versionState: 'missing', projectIdState: 'missing',
  }
  for (const [key, valueKey, stateKey] of FIELDS) {
    const node = objectProperty(document.root, key)
    if (!node) continue
    info[stateKey] = 'invalid'
    if (node.kind !== 'string' || typeof node.value !== 'string' || !node.value.trim()) continue
    info[stateKey] = 'present'
    // Presentation only; never use the bounded value as document identity
    const text = node.value.trim()
    info[valueKey] = text.length > INSPECTOR_FILE_INFO_TEXT_LIMIT ? text.slice(0, INSPECTOR_FILE_INFO_TEXT_LIMIT - 3) + '...' : text
  }
  return info
}

export function readInspectorFileInfo(cache: unknown): InspectorFileInfo | undefined {
  if (!cache || typeof cache !== 'object') return undefined
  const row = cache as Record<string, unknown>
  if (row.schemaVersion !== INSPECTOR_FILE_INFO_SCHEMA_VERSION || typeof row.edited !== 'boolean') return undefined
  for (const [, valueKey, stateKey] of FIELDS) {
    const state = row[stateKey]
    const value = row[valueKey]
    if (state !== 'present' && state !== 'missing' && state !== 'invalid') return undefined
    if (state === 'present' ? typeof value !== 'string' || !value.trim() || value.length > INSPECTOR_FILE_INFO_TEXT_LIMIT : value !== undefined) return undefined
  }
  return {
    schemaVersion: INSPECTOR_FILE_INFO_SCHEMA_VERSION, edited: row.edited,
    title: row.title as string | undefined, version: row.version as string | undefined, projectId: row.projectId as string | undefined,
    titleState: row.titleState as InspectorFileInfoState, versionState: row.versionState as InspectorFileInfoState, projectIdState: row.projectIdState as InspectorFileInfoState,
  }
}
