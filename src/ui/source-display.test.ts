import { describe, expect, it } from 'vitest'
import { sourceDisplay } from './source-display'

describe('sourceDisplay', () => {
  it('uses the public provenance label while retaining the source host', () => {
    const display = sourceDisplay('https://crystal-project.fandom.com/wiki/Aegis')
    expect(display).toEqual({ label: 'Community wiki · Aegis', detail: 'crystal-project.fandom.com' })
  })

  it('keeps unknown URLs and plain identifiers identifiable', () => {
    expect(sourceDisplay('https://example.test/source/long-id')).toEqual({ label: 'example.test', detail: 'https://example.test/source/long-id' })
    expect(sourceDisplay('https://www.example.test/source')).toEqual({ label: 'example.test', detail: 'https://www.example.test/source' })
    expect(sourceDisplay('local-pack')).toEqual({ label: 'local-pack' })
  })
})
