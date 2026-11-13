import { describe, expect, it } from 'vitest'
import { previewResearchJson } from './research'

const bytes = (value: string) => new TextEncoder().encode(value)

describe('external research source identity', () => {
  it('does not grant a supplied catalog ID the bundled vanilla namespace', async () => {
    const preview = await previewResearchJson(bytes('{"schema_version":"1.1.0","catalog_id":"crystal-project/vanilla","items":[]}'), 'source.json')
    expect(preview.proposed.catalogs[0]!.id).toMatch(/^crystal-project\/imported\/research1-[a-f0-9]{64}$/)
  })

  it('uses identical content and interpretation for equivalent JSON and keeps the raw archives', async () => {
    const a = await previewResearchJson(bytes('{"schema_version":"1.1.0","catalog_id":"project","items":[]}'), 'a.json')
    const b = await previewResearchJson(bytes('{ "items":[], "catalog_id":"project", "schema_version":"1.1.0" }'), 'b.json')
    expect(a.proposed.catalogs).toEqual(b.proposed.catalogs)
    expect(a.proposed.sources[0]!.digest).not.toBe(b.proposed.sources[0]!.digest)
  })
})
