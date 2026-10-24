import type { InspectorFileInfo, InspectorFileInfoState } from './types'

// Retained-row admission only needs the cache contract, not the imported document/catalog parser
export const INSPECTOR_FILE_INFO_SCHEMA_VERSION = 1
export const INSPECTOR_FILE_INFO_TEXT_LIMIT = 160

export const INSPECTOR_FILE_INFO_FIELDS = Object.freeze([
  ['Title', 'title', 'titleState'],
  ['Version', 'version', 'versionState'],
  ['ID', 'projectId', 'projectIdState'],
] as const)

export function readInspectorFileInfo(cache: unknown): InspectorFileInfo | undefined {
  if (!cache || typeof cache !== 'object') return undefined
  const row = cache as Record<string, unknown>
  if (row.schemaVersion !== INSPECTOR_FILE_INFO_SCHEMA_VERSION || typeof row.edited !== 'boolean') return undefined
  for (const [, valueKey, stateKey] of INSPECTOR_FILE_INFO_FIELDS) {
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
