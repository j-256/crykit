import { expect, it } from 'vitest'
import { formatEntityRefPath, parseEntityRefPath } from './navigation/entities'
import type { CatalogRef, EntityRef } from '../domain/types'

const key = `ce1-${'a'.repeat(64)}`
const revision = `j1-${'b'.repeat(64)}-p1`
const ref = (catalogId: string, catalogRevisionId: string, entityId: string) => ({ kind: 'catalog', catalogId, catalogRevisionId, entityId }) as CatalogRef

it('uses exact source routes with independent family, mode, revision, and descriptive slug', () => {
  const cases: readonly [CatalogRef, string][] = [
    [ref('crystal-project/vanilla', 'v1', 'base:equipment:3'), 'crystal-project/vanilla/v1/equipment/3/dirk'],
    [ref('crystal-project/vanilla', 'v2', 'base:monster:3:mode:Chaos'), 'crystal-project/vanilla/v2/mode/Chaos/monster/3/dirk'],
    [ref('crystal-project/guide/modding', 'v1', 'ref-385'), 'crystal-project/guide/modding/v1/entries/ref-385/dirk'],
    [ref('crystal-project/mod/dirk-god-mode', 'v1', 'mod:dirk-god-mode:equipment:3'), 'crystal-project/mod/dirk-god-mode/v1/equipment/3/dirk'],
    [ref(`crystal-project/imported/${key}`, revision, `mod:${key}:equipment:3`), `crystal-project/imported/${key}/${revision}/equipment/3/dirk`],
    [ref(`crystal-project/imported/${key}`, revision, `mod:${key}:class:3`), `crystal-project/imported/${key}/${revision}/job/3/dirk`],
    [ref(`crystal-project/imported/${key}`, revision, 'research / record:search'), `crystal-project/imported/${key}/${revision}/entries/research%20%2F%20record%3Asearch/dirk`],
  ]
  for (const [value, path] of cases) {
    expect(formatEntityRefPath(value, () => 'Dirk')).toBe(path)
    expect(parseEntityRefPath(path.split('/'))).toEqual({ ref: value, consumed: path.split('/').length })
    expect(parseEntityRefPath(path.replace(/dirk$/, 'stale-name').split('/'))?.ref).toEqual(value)
  }
})

it('keeps personal and local composition identities separate from source origins', () => {
  const composition = ref('crystal-project/vanilla', 'mod-setup:synthetic', 'base:equipment:3')
  expect(formatEntityRefPath(composition)).toBe('local/catalog/crystal-project%2Fvanilla/mod-setup%3Asynthetic/entries/base%3Aequipment%3A3/definition')
  const personal = { kind: 'personal', definitionId: 'edit / one' } as EntityRef
  for (const value of [composition, personal]) {
    const path = formatEntityRefPath(value)
    expect(parseEntityRefPath([...path.split('/'), 'edit'])?.ref).toEqual(value)
  }
})

it('rejects prelaunch aliases, malformed source revisions, and ambiguous encodings', () => {
  for (const path of [
    'catalog/v1/base/equipment/3/dirk',
    'crystal-project/vanilla/catalog-v3/equipment/3/dirk',
    'crystal-project/vanilla/v1/equipment/03/dirk',
    'crystal-project/vanilla/v1/equipment/4294967296/dirk',
    'crystal-project/vanilla/v1/mode/base/equipment/3/dirk',
    'crystal-project/vanilla/v1/equipment/3/bad%2Fslug',
    'crystal-project/vanilla/v1/equipment/3',
    'crystal-project/imported/forged/v1/equipment/3/dirk',
    'crystal-project/guide/modding/v1/equipment/3/dirk',
  ]) expect(parseEntityRefPath(path.split('/')), path).toBeUndefined()
})
