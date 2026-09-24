import { AppDataError } from './errors'
import { isJsonObject, parseBoundedJson } from './json'
import { previewNativeBackup } from './native'
import { previewXlsx } from './normalize-xlsx'
import { previewResearchJson } from './research'
import type { ImportPreview } from './types'
import { inspectZip, safeUnzip } from './zip'

export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

function firstJsonByte(bytes: Uint8Array): number | undefined {
  let index = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3
  while (index < bytes.length && [0x09, 0x0a, 0x0d, 0x20].includes(bytes[index] as number)) index += 1
  return bytes[index]
}

function looksLikeResearchJson(bytes: Uint8Array, label: string): boolean {
  try {
    const value = parseBoundedJson(bytes, label)
    return isJsonObject(value) && value.schema_version === '1.1.0'
  } catch {
    return false
  }
}

export async function previewImport(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new AppDataError('unsupported-format', 'The selected file is empty or larger than the import limit', {
      recoverable: true,
      details: { limit: MAX_IMPORT_BYTES },
    })
  }
  const leadingByte = firstJsonByte(bytes)
  if (leadingByte === 0x7b) return previewResearchJson(bytes, filename)
  if (!isZip(bytes)) {
    throw new AppDataError('unsupported-format', 'Select a supported research JSON, research ZIP, XLSX, or native backup', {
      recoverable: true,
    })
  }

  const directory = inspectZip(bytes)
  const names = new Set(directory.entries.map((entry) => entry.name))
  if (names.has('[Content_Types].xml') && names.has('_rels/.rels')) return previewXlsx(bytes, filename)
  if (names.has('manifest.json') && names.has('bundle.json')) return previewNativeBackup(bytes, filename)

  const jsonEntries = directory.entries.filter(
    (entry) => !entry.isDirectory && entry.name.toLocaleLowerCase().endsWith('.json'),
  )
  if (jsonEntries.length === 0) {
    throw new AppDataError('unsupported-format', 'The ZIP does not contain a supported import payload', {
      recoverable: true,
    })
  }
  const { files } = safeUnzip(bytes, { select: new Set(jsonEntries.map((entry) => entry.name)) })
  const candidates = jsonEntries.filter((entry) => {
    const data = files.get(entry.name)
    return data ? looksLikeResearchJson(data, entry.name) : false
  })
  if (candidates.length !== 1) {
    throw new AppDataError('schema-mismatch', 'A research ZIP must contain exactly one schema 1.1.0 JSON payload', {
      recoverable: true,
      details: { candidates: candidates.map((entry) => entry.name) },
    })
  }
  const candidate = candidates[0]
  const data = candidate ? files.get(candidate.name) : undefined
  if (!candidate || !data) {
    throw new AppDataError('schema-mismatch', 'The research ZIP payload could not be read', { recoverable: true })
  }
  return previewResearchJson(data, candidate.name, {
    containerBytes: bytes,
    containerFilename: filename,
    format: 'research-zip-1.1.0',
  })
}
