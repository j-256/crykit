import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGameExecutableVersion } from './game-version.mjs'

const align = value => Math.ceil(value / 4) * 4

function block(key, value = Buffer.alloc(0), children = [], type = 1) {
  const name = Buffer.from(`${key}\0`, 'utf16le')
  const valueOffset = align(6 + name.length)
  const childOffset = align(valueOffset + value.length)
  const result = Buffer.alloc(childOffset + children.reduce((sum, child) => sum + align(child.length), 0))
  result.writeUInt16LE(result.length, 0)
  result.writeUInt16LE(type === 1 ? value.length / 2 : value.length, 2)
  result.writeUInt16LE(type, 4)
  name.copy(result, 6)
  value.copy(result, valueOffset)
  let cursor = childOffset
  for (const child of children) { child.copy(result, cursor); cursor += align(child.length) }
  return result
}

function executable({ version = '1.6.9.0', assemblyVersion = version, productName = 'Crystal Project' } = {}) {
  const parts = version.split('.').map(Number)
  const fixed = Buffer.alloc(52)
  fixed.writeUInt32LE(0xfeef04bd, 0)
  fixed.writeUInt32LE(0x10000, 4)
  for (const offset of [8, 16]) {
    fixed.writeUInt32LE(parts[0] * 0x10000 + parts[1], offset)
    fixed.writeUInt32LE(parts[2] * 0x10000 + parts[3], offset + 4)
  }
  const strings = Object.entries({ FileVersion: version, ProductVersion: version, 'Assembly Version': assemblyVersion, ProductName: productName }).map(([key, value]) => block(key, Buffer.from(`${value}\0`, 'utf16le')))
  const info = block('VS_VERSION_INFO', fixed, [block('StringFileInfo', Buffer.alloc(0), [block('040904b0', Buffer.alloc(0), strings)])], 0)
  const resourceSize = 96 + info.length
  const bytes = Buffer.alloc(512 + resourceSize)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(128, 60)
  bytes.writeUInt32LE(0x4550, 128)
  bytes.writeUInt16LE(1, 134)
  bytes.writeUInt16LE(224, 148)
  bytes.writeUInt16LE(0x10b, 152)
  bytes.writeUInt32LE(0x1000, 264)
  bytes.writeUInt32LE(resourceSize, 268)
  bytes.writeUInt32LE(resourceSize, 392)
  bytes.writeUInt32LE(0x1000, 388)
  bytes.writeUInt32LE(512, 396)
  for (const [offset, id, target] of [[0, 16, 0x80000018], [24, 1, 0x80000030], [48, 1033, 72]]) {
    bytes.writeUInt16LE(1, 512 + offset + 14)
    bytes.writeUInt32LE(id, 512 + offset + 16)
    bytes.writeUInt32LE(target, 512 + offset + 20)
  }
  bytes.writeUInt32LE(0x1060, 584)
  bytes.writeUInt32LE(info.length, 588)
  info.copy(bytes, 608)
  return bytes
}

test('reads version evidence from the PE resource rather than arbitrary strings', () => {
  assert.deepEqual(parseGameExecutableVersion(executable()), { gameVersion: '1.6.9', fileVersion: '1.6.9.0', productVersion: '1.6.9.0', assemblyVersion: '1.6.9.0', productName: 'Crystal Project' })
  assert.equal(parseGameExecutableVersion(executable({ version: '1.6.6.0' })).gameVersion, '1.6.6')
})

test('rejects conflicting version evidence and other products', () => {
  assert.throws(() => parseGameExecutableVersion(executable({ assemblyVersion: '1.6.6.0' })), /disagree/)
  assert.throws(() => parseGameExecutableVersion(executable({ productName: 'Synthetic Other Game' })), /disagree/)
})

test('rejects missing, truncated, and out-of-bounds resource data', () => {
  assert.throws(() => parseGameExecutableVersion(Buffer.from('1.6.9.0')), /Windows executable/)
  assert.throws(() => parseGameExecutableVersion(executable().subarray(0, 600)), /truncated/)
  const invalid = executable()
  invalid.writeUInt32LE(0xfffffffc, 532)
  assert.throws(() => parseGameExecutableVersion(invalid), /bounds/)
})
