const VERSION_RESOURCE_TYPE = 16
const FIXED_VERSION_SIGNATURE = 0xfeef04bd
const RESOURCE_DIRECTORY_FLAG = 0x80000000
const VERSION_INFO_KEY = 'VS_VERSION_INFO'
const align = value => Math.ceil(value / 4) * 4

export function parseGameExecutableVersion(bytes) {
  const requireBytes = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error('Executable version resource is truncated')
  }
  const u16 = offset => { requireBytes(offset, 2); return bytes.readUInt16LE(offset) }
  const u32 = offset => { requireBytes(offset, 4); return bytes.readUInt32LE(offset) }
  if (u16(0) !== 0x5a4d) throw new Error('Input is not a Windows executable')
  const pe = u32(0x3c)
  if (u32(pe) !== 0x4550) throw new Error('Input has no valid PE header')
  const sectionCount = u16(pe + 6)
  const optional = pe + 24
  const optionalSize = u16(pe + 20)
  const magic = u16(optional)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported executable optional header')
  const directories = optional + (magic === 0x10b ? 96 : 112)
  if (directories + 24 > optional + optionalSize) throw new Error('Executable has no resource directory')
  const resourceRva = u32(directories + 16)
  const resourceSize = u32(directories + 20)
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = optional + optionalSize + index * 40
    requireBytes(offset, 40)
    sections.push({ rva: u32(offset + 12), size: u32(offset + 16), file: u32(offset + 20) })
  }
  const fileOffset = (rva, size) => {
    const section = sections.find(entry => rva >= entry.rva && rva + size <= entry.rva + entry.size)
    if (!section) throw new Error('Executable resource points outside a file section')
    const offset = section.file + rva - section.rva
    requireBytes(offset, size)
    return offset
  }
  const resource = fileOffset(resourceRva, resourceSize)
  const resourceOffset = (relative, size) => {
    if (relative < 0 || relative + size > resourceSize) throw new Error('Executable resource directory is out of bounds')
    return resource + relative
  }
  const entries = relative => {
    const offset = resourceOffset(relative, 16)
    const count = u16(offset + 12) + u16(offset + 14)
    resourceOffset(relative + 16, count * 8)
    return Array.from({ length: count }, (_, index) => ({ id: u32(offset + 16 + index * 8), target: u32(offset + 20 + index * 8) }))
  }
  const type = entries(0).find(entry => entry.id === VERSION_RESOURCE_TYPE)
  if (!type || !(type.target & RESOURCE_DIRECTORY_FLAG)) throw new Error('Executable has no version resource')
  const leaves = []
  const visit = (relative, depth) => {
    if (depth > 2) throw new Error('Executable version directory has excessive depth')
    for (const entry of entries(relative)) {
      if (entry.target & RESOURCE_DIRECTORY_FLAG) visit(entry.target & ~RESOURCE_DIRECTORY_FLAG, depth + 1)
      else leaves.push(resourceOffset(entry.target, 16))
    }
  }
  visit(type.target & ~RESOURCE_DIRECTORY_FLAG, 0)
  if (leaves.length !== 1) throw new Error('Executable must have exactly one version resource')
  const start = fileOffset(u32(leaves[0]), u32(leaves[0] + 4))
  const end = start + u16(start)
  if (end > start + u32(leaves[0] + 4)) throw new Error('Executable version block is out of bounds')
  const strings = {}
  let fixedVersion
  const parseBlock = (offset, limit, depth) => {
    if (depth > 8 || offset + 6 > limit) throw new Error('Invalid executable version block')
    const length = u16(offset)
    const valueLength = u16(offset + 2)
    const type = u16(offset + 4)
    const blockEnd = offset + length
    if (length < 6 || blockEnd > limit) throw new Error('Invalid executable version block length')
    let cursor = offset + 6
    const keyStart = cursor
    while (cursor + 2 <= blockEnd && u16(cursor)) cursor += 2
    if (cursor + 2 > blockEnd) throw new Error('Executable version key is unterminated')
    const key = bytes.subarray(keyStart, cursor).toString('utf16le')
    cursor = align(cursor + 2)
    const valueSize = valueLength * (type === 1 ? 2 : 1)
    if (cursor + valueSize > blockEnd) throw new Error('Executable version value is out of bounds')
    if (key === VERSION_INFO_KEY) {
      if (valueSize < 52 || u32(cursor) !== FIXED_VERSION_SIGNATURE) throw new Error('Executable has no valid fixed version information')
      const version = position => [u16(position + 2), u16(position), u16(position + 6), u16(position + 4)].join('.')
      fixedVersion = { fileVersion: version(cursor + 8), productVersion: version(cursor + 16) }
    } else if (type === 1 && valueLength) strings[key] = bytes.subarray(cursor, cursor + valueSize).toString('utf16le').replace(/\0+$/, '')
    cursor = align(cursor + valueSize)
    while (cursor + 6 <= blockEnd) {
      const childLength = parseBlock(cursor, blockEnd, depth + 1)
      cursor = align(cursor + childLength)
    }
    return length
  }
  parseBlock(start, end, 0)
  if (!fixedVersion || strings.FileVersion !== fixedVersion.fileVersion || strings.ProductVersion !== fixedVersion.productVersion || strings['Assembly Version'] !== fixedVersion.fileVersion || strings.ProductName !== 'Crystal Project') throw new Error('Crystal Project executable version fields disagree or are absent')
  if (fixedVersion.fileVersion !== fixedVersion.productVersion) throw new Error('Crystal Project file and product versions disagree')
  const parts = fixedVersion.fileVersion.split('.')
  return { gameVersion: parts[3] === '0' ? parts.slice(0, 3).join('.') : fixedVersion.fileVersion, ...fixedVersion, assemblyVersion: strings['Assembly Version'], productName: strings.ProductName }
}
