import { unzipSync } from 'fflate'
import { AppDataError } from './errors'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const MAX_EOCD_SEARCH = 65_557
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30

export interface ArchiveLimits {
  maxCompressedBytes: number
  maxEntries: number
  maxEntryUncompressedBytes: number
  maxTotalUncompressedBytes: number
  maxInflationRatio: number
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxCompressedBytes: 32 * 1024 * 1024,
  maxEntries: 512,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxInflationRatio: 100,
})

export interface ZipEntryMetadata {
  name: string
  compressedSize: number
  uncompressedSize: number
  crc32: number
  compression: 0 | 8
  localHeaderOffset: number
  dataOffset: number
  isDirectory: boolean
}

export interface ZipDirectory {
  entries: readonly ZipEntryMetadata[]
  compressedBytes: number
  totalUncompressedBytes: number
}

function invalidZip(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AppDataError('invalid-zip', message, { recoverable: true, details })
}

function unsafeArchive(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AppDataError('unsafe-archive', message, { recoverable: true, details })
}

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) invalidZip('The ZIP structure is truncated')
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) invalidZip('The ZIP structure is truncated')
  return view.getUint32(offset, true)
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - MAX_EOCD_SEARCH)
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(view, offset) !== EOCD_SIGNATURE) continue
    const commentLength = readU16(view, offset + 20)
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  invalidZip('The ZIP end-of-directory record is missing or malformed')
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((value) => value > 0x7f)) {
    unsafeArchive('ZIP entry names must be ASCII or explicitly UTF-8')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new AppDataError('invalid-zip', 'A ZIP entry name is not valid UTF-8', {
      recoverable: true,
      cause: error,
    })
  }
}

export function normalizeArchivePath(name: string): string {
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    unsafeArchive('The archive contains an unsafe entry path', { path: name })
  }
  const directory = name.endsWith('/')
  const segments = name.split('/')
  if (directory) segments.pop()
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    unsafeArchive('The archive contains an unsafe entry path', { path: name })
  }
  return `${segments.join('/')}${directory ? '/' : ''}`
}

function checkedAdd(total: number, value: number, limit: number, message: string): number {
  const result = total + value
  if (!Number.isSafeInteger(result) || result > limit) unsafeArchive(message, { limit })
  return result
}

export function inspectZip(
  bytes: Uint8Array,
  limits: Readonly<ArchiveLimits> = DEFAULT_ARCHIVE_LIMITS,
): ZipDirectory {
  if (bytes.byteLength > limits.maxCompressedBytes) {
    unsafeArchive('The archive is larger than the import limit', { limit: limits.maxCompressedBytes })
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  const diskNumber = readU16(view, eocd + 4)
  const centralDisk = readU16(view, eocd + 6)
  const diskEntries = readU16(view, eocd + 8)
  const entryCount = readU16(view, eocd + 10)
  const centralSize = readU32(view, eocd + 12)
  const centralOffset = readU32(view, eocd + 16)
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    unsafeArchive('Multi-disk ZIP archives are not supported')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    unsafeArchive('ZIP64 archives are not supported')
  }
  if (entryCount > limits.maxEntries) {
    unsafeArchive('The archive contains too many entries', { limit: limits.maxEntries })
  }
  if (centralOffset + centralSize !== eocd || centralOffset + centralSize > bytes.byteLength) {
    invalidZip('The ZIP central directory is inconsistent')
  }

  const entries: ZipEntryMetadata[] = []
  const names = new Set<string>()
  const entryRanges: Array<readonly [number, number]> = []
  let totalUncompressedBytes = 0
  let cursor = centralOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(view, cursor) !== CENTRAL_FILE_SIGNATURE) invalidZip('A ZIP central-directory entry is malformed')
    const versionMadeBy = readU16(view, cursor + 4)
    const flags = readU16(view, cursor + 8)
    const compression = readU16(view, cursor + 10)
    const crc = readU32(view, cursor + 16)
    const compressedSize = readU32(view, cursor + 20)
    const uncompressedSize = readU32(view, cursor + 24)
    const nameLength = readU16(view, cursor + 28)
    const extraLength = readU16(view, cursor + 30)
    const commentLength = readU16(view, cursor + 32)
    const diskStart = readU16(view, cursor + 34)
    const externalAttributes = readU32(view, cursor + 38)
    const localHeaderOffset = readU32(view, cursor + 42)
    const end = cursor + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
    if (end > centralOffset + centralSize) invalidZip('A ZIP central-directory entry is truncated')
    if (diskStart !== 0) unsafeArchive('Multi-disk ZIP entries are not supported')
    if ((flags & 0x1) !== 0) unsafeArchive('Encrypted ZIP entries are not supported')
    if (compression !== 0 && compression !== 8) {
      unsafeArchive('The archive uses an unsupported compression method', { compression })
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      unsafeArchive('ZIP64 entries are not supported')
    }
    const unixMode = versionMadeBy >>> 8 === 3 ? externalAttributes >>> 16 : 0
    if ((unixMode & 0xf000) === 0xa000) unsafeArchive('Symbolic links are not allowed in imports')

    const rawName = bytes.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength)
    const name = normalizeArchivePath(decodeEntryName(rawName, (flags & 0x800) !== 0))
    if (names.has(name)) unsafeArchive('The archive contains duplicate entry paths', { path: name })
    names.add(name)
    const isDirectory = name.endsWith('/')
    if (!isDirectory && uncompressedSize > limits.maxEntryUncompressedBytes) {
      unsafeArchive('An archive entry is larger than the import limit', {
        path: name,
        limit: limits.maxEntryUncompressedBytes,
      })
    }
    if (!isDirectory && uncompressedSize > 0) {
      if (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxInflationRatio) {
        unsafeArchive('An archive entry exceeds the inflation-ratio limit', {
          path: name,
          limit: limits.maxInflationRatio,
        })
      }
      totalUncompressedBytes = checkedAdd(
        totalUncompressedBytes,
        uncompressedSize,
        limits.maxTotalUncompressedBytes,
        'The archive expands beyond the import limit',
      )
    }

    if (readU32(view, localHeaderOffset) !== LOCAL_FILE_SIGNATURE) invalidZip('A ZIP local-file header is missing')
    const localFlags = readU16(view, localHeaderOffset + 6)
    const localCompression = readU16(view, localHeaderOffset + 8)
    const localNameLength = readU16(view, localHeaderOffset + 26)
    const localExtraLength = readU16(view, localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength
    const dataEnd = dataOffset + compressedSize
    if (localFlags !== flags || localCompression !== compression || dataEnd > centralOffset) {
      invalidZip('A ZIP local-file header does not match its central-directory entry', { path: name })
    }
    if ((flags & 0x8) === 0) {
      const localCrc = readU32(view, localHeaderOffset + 14)
      const localCompressedSize = readU32(view, localHeaderOffset + 18)
      const localUncompressedSize = readU32(view, localHeaderOffset + 22)
      if (localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
        invalidZip('A ZIP local-file header has inconsistent size or checksum metadata', { path: name })
      }
    }
    const localRawName = bytes.subarray(localHeaderOffset + LOCAL_HEADER_SIZE, localHeaderOffset + LOCAL_HEADER_SIZE + localNameLength)
    const localName = normalizeArchivePath(decodeEntryName(localRawName, (localFlags & 0x800) !== 0))
    if (localName !== name) invalidZip('A ZIP entry has mismatched path records')
    entryRanges.push([localHeaderOffset, dataEnd])

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      compression: compression as 0 | 8,
      localHeaderOffset,
      dataOffset,
      isDirectory,
    })
    cursor = end
  }
  if (cursor !== centralOffset + centralSize) invalidZip('The ZIP central directory has trailing data')
  entryRanges.sort((left, right) => left[0] - right[0])
  for (let index = 1; index < entryRanges.length; index += 1) {
    const previous = entryRanges[index - 1]
    const current = entryRanges[index]
    if (previous && current && current[0] < previous[1]) unsafeArchive('ZIP entry data overlaps')
  }
  return { entries, compressedBytes: bytes.byteLength, totalUncompressedBytes }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of data) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface SafeUnzipResult {
  directory: ZipDirectory
  files: ReadonlyMap<string, Uint8Array>
}

export function safeUnzip(
  bytes: Uint8Array,
  options: {
    limits?: Readonly<ArchiveLimits>
    select?: ReadonlySet<string> | ((entry: ZipEntryMetadata) => boolean)
  } = {},
): SafeUnzipResult {
  const directory = inspectZip(bytes, options.limits)
  const selected = new Set(
    directory.entries
      .filter((entry) => {
        if (entry.isDirectory) return false
        if (!options.select) return true
        return typeof options.select === 'function' ? options.select(entry) : options.select.has(entry.name)
      })
      .map((entry) => entry.name),
  )
  let extracted: Record<string, Uint8Array>
  try {
    extracted = unzipSync(bytes, { filter: (entry) => selected.has(entry.name) })
  } catch (error) {
    throw new AppDataError('invalid-zip', 'The archive could not be decompressed safely', {
      recoverable: true,
      cause: error,
    })
  }
  const files = new Map<string, Uint8Array>()
  for (const entry of directory.entries) {
    if (!selected.has(entry.name)) continue
    const data = extracted[entry.name]
    if (!data || data.byteLength !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
      invalidZip('An extracted ZIP entry failed its size or checksum validation', { path: entry.name })
    }
    files.set(entry.name, data)
  }
  return { directory, files }
}
