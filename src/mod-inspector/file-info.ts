import { INSPECTOR_FILE_INFO_SCHEMA_VERSION, INSPECTOR_FILE_INFO_TEXT_LIMIT, INSPECTOR_FILE_INFO_FIELDS, readInspectorFileInfo } from './file-info-contract'
export { INSPECTOR_FILE_INFO_SCHEMA_VERSION, INSPECTOR_FILE_INFO_TEXT_LIMIT, readInspectorFileInfo } from './file-info-contract'
import { objectProperty } from './document'
import type { InspectorFileInfo, InspectorFileInfoState, ParsedDocument } from './types'
import type { JsonValue } from '../domain/types'
import { isJsonObject } from '../interchange/json'

export function inspectorInputFileInfo(fields: JsonValue): InspectorFileInfo | undefined {
  return isJsonObject(fields) ? readInspectorFileInfo(fields.fileInfo) : undefined
}

export function withInspectorInputFileInfo(fields: JsonValue, info: InspectorFileInfo): JsonValue {
  if (fields !== null && !isJsonObject(fields)) return fields
  const previous = fields?.fileInfo
  if (previous !== undefined && isJsonObject(previous) && typeof previous.schemaVersion === 'number' && previous.schemaVersion > INSPECTOR_FILE_INFO_SCHEMA_VERSION) return fields
  // This bounded hint travels in the existing inert form namespace, never as file or source authority
  // Preserve unknown form values and future hint versions instead of interpreting them as this format
  // Legacy readers materialize absent optional fields as undefined, which is not a JSON value
  const hint = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined))
  return { ...fields, fileInfo: hint as JsonValue }
}

export function deriveInspectorFileInfo(document: ParsedDocument, edited: boolean): InspectorFileInfo {
  const info: { schemaVersion: 1; edited: boolean; title?: string; version?: string; projectId?: string; titleState: InspectorFileInfoState; versionState: InspectorFileInfoState; projectIdState: InspectorFileInfoState } = {
    schemaVersion: INSPECTOR_FILE_INFO_SCHEMA_VERSION, edited, titleState: 'missing', versionState: 'missing', projectIdState: 'missing',
  }
  for (const [key, valueKey, stateKey] of INSPECTOR_FILE_INFO_FIELDS) {
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
