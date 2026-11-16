import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import manifest from './menu-icon-supplements.json'

describe('supplemental menu glyph integrity', () => {
  it('keeps every local image byte and dimension pinned to its attributed source asset', () => {
    const used = new Set(Object.values(manifest.icons).map(binding => binding.asset))
    expect(Object.keys(manifest.assets).sort()).toEqual([...used].sort())
    const directory = new URL('../assets/menu-icon-supplements/', import.meta.url)
    expect(readdirSync(directory).sort()).toEqual(Object.values(manifest.assets).map(asset => asset.file).sort())
    for (const asset of Object.values(manifest.assets)) {
      const bytes = readFileSync(new URL(asset.file, directory))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
      expect(createHash('sha1').update(bytes).digest('hex')).toBe(asset.sha1)
      expect(bytes.length).toBe(asset.size)
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(bytes.readUInt32BE(16)).toBe(asset.width)
      expect(bytes.readUInt32BE(20)).toBe(asset.height)
      expect(asset.descriptionUrl).toMatch(/^https:\/\/crystal-project\.fandom\.com\/wiki\/File.+\?oldid=\d+$/)
      expect(asset.license.trim()).not.toBe('')
    }
  })
})
