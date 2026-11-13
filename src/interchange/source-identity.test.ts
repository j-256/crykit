import { describe, expect, it } from 'vitest'
import { crystalEditSourceKey } from './source-identity'

describe('portable declared project identity', () => {
  it('uses the versioned game and format namespace independently of a display name', async () => {
    expect(await crystalEditSourceKey('synthetic-project')).toBe('ce1-f53144868076c74da368ec7702c3a096f1c16ccde346e7d257991e966c5a7e40')
  })

  it('preserves case, surrounding spaces, and distinct Unicode project IDs', async () => {
    const keys = await Promise.all(['id', 'ID', ' id ', 'é', 'e\u0301'].map(crystalEditSourceKey))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each(['', ' ', 'a\u0000b', 'a\u007fb', 'a'.repeat(513)])('rejects invalid declared project identity %j', async id => {
    await expect(crystalEditSourceKey(id)).rejects.toThrow()
  })
})
