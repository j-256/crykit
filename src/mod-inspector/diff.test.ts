import { describe, expect, it } from 'vitest'
import { parseDocument } from './document'
import { diffDocuments } from './diff'

const diff = (before: string, after: string) => diffDocuments(parseDocument(before), parseDocument(after))
const records = (ids: readonly number[]) => JSON.stringify({ Rows: ids.map(ID => ({ ID, Name: `Synthetic ${ID}`, Unknown: { value: ID } })) })

describe('structural inspector diffs', () => {
  it('ignores whitespace, property order, string escapes and proven numeric equivalents', () => {
    expect(diff('{"x":1,"y":{"a":"A","b":1e400},"z":-0}', '{ "z":0.0, "y":{"b":10e399,"a":"\\u0041"}, "x":1.00 }')).toEqual([])
  })

  it('ignores only structural whitespace and preserves spaces inside escaped strings', () => {
    const original = '{"value":"one two \\"quoted\\" \\\\ tail","rows":[1,2]}'
    expect(diff(original, '{ "value" : "one two \\"quoted\\" \\\\ tail", "rows" : [ 1, 2 ] }')).toEqual([])
    expect(diff(original, original.replace('one two', 'onetwo'))).toHaveLength(1)
  })

  it('reports distinct arbitrarily large numbers and preserves unknown changes', () => {
    const changes = diff('{"ID":900719925474099312345,"Unknown":{"value":null}}', '{"ID":900719925474099312346,"Unknown":{"value":false}}')
    expect(changes.map(change => change.path)).toEqual([['ID'], ['Unknown', 'value']])
    expect(changes[0].before?.raw).toBe('900719925474099312345')
    expect(changes[0].after?.raw).toBe('900719925474099312346')
  })

  it('handles enormous exponent lexemes conservatively without unbounded integer conversion', () => {
    const exponent = '9'.repeat(1000)
    expect(diff(`{"value":1e${exponent}}`, `{"value":2e${exponent}}`)).toHaveLength(1)
    expect(diff(`{"value":1e${exponent}}`, `{"value":1e${exponent}}`)).toEqual([])
    expect(diff('{"value":1e00000000000000000000000000000000001}', '{"value":10}')).toEqual([])
  })

  it('tracks record moves alongside nested edits and names each record group', () => {
    const before = '{"Abilities":[{"ID":1,"Name":"First","Unknown":{"power":2}},{"ID":2,"Name":"Second"}]}'
    const after = '{"Abilities":[{"Name":"Second","ID":2},{"ID":1,"Name":"First","Unknown":{"power":3}}]}'
    const changes = diff(before, after)
    const moves = changes.filter(change => change.kind === 'moved')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ beforePath: ['Abilities', 1], path: ['Abilities', 0], group: 'Abilities: Second (ID 2)' })
    const edited = changes.find(change => change.kind === 'changed')!
    expect(edited.path).toEqual(['Abilities', 1, 'Unknown', 'power'])
    expect(edited.beforePath).toEqual(['Abilities', 0, 'Unknown', 'power'])
    expect(edited.group).toBe('Abilities: First (ID 1)')
  })

  it('reports only the added record when inserting at the front', () => {
    const changes = diff(records([1, 2, 3]), records([0, 1, 2, 3]))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'added', path: ['Rows', 0], group: 'Rows: Synthetic 0 (ID 0)' })
  })

  it('reports only the removed record when deleting from the front', () => {
    const changes = diff(records([0, 1, 2, 3]), records([1, 2, 3]))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'removed', path: ['Rows', 0], group: 'Rows: Synthetic 0 (ID 0)' })
  })

  it('matches nested edits by ID despite insertion shifts without adding moves', () => {
    const before = records([1, 2, 3])
    const after = records([0, 1, 2, 3]).replace('"value":2', '"value":20')
    const changes = diff(before, after)
    expect(changes.map(change => change.kind)).toEqual(['changed', 'added'])
    expect(changes[0]).toMatchObject({ path: ['Rows', 2, 'Unknown', 'value'], beforePath: ['Rows', 1, 'Unknown', 'value'], group: 'Rows: Synthetic 2 (ID 2)' })
  })

  it('reports a deterministic minimal set of moves for a genuine block reorder', () => {
    const changes = diff(records([1, 2, 3, 4, 5]), records([3, 4, 5, 1, 2]))
    expect(changes.map(change => ({ kind: change.kind, beforePath: change.beforePath, path: change.path }))).toEqual([
      { kind: 'moved', beforePath: ['Rows', 0], path: ['Rows', 3] },
      { kind: 'moved', beforePath: ['Rows', 1], path: ['Rows', 4] },
    ])
    expect(diff(records([1, 2, 3, 4, 5]), records([3, 4, 5, 1, 2])).map(change => change.path)).toEqual(changes.map(change => change.path))
  })

  it('does not report moves or edits for equivalent ID lexemes and property order', () => {
    expect(diff('{"Rows":[{"ID":1,"Name":"Synthetic"},{"ID":1e400}]}', '{ "Rows": [ {"Name":"Synthetic", "ID":1.0}, {"ID":10e399} ] }')).toEqual([])
  })

  it('tracks additions and removals without hiding their unknown subtrees', () => {
    const changes = diff('{"Rows":[{"ID":1,"Name":"Removed","Unknown":{"deep":[1,2]}}],"old":true}', '{"Rows":[{"ID":2,"Name":"Added","Unknown":{"deep":[3,4]}}],"new":null}')
    expect(changes.map(change => change.kind)).toEqual(['removed', 'added', 'removed', 'added'])
    expect(changes[0].before?.raw).toContain('"deep":[1,2]')
    expect(changes[1].after?.raw).toContain('"deep":[3,4]')
    expect(changes[1].group).toBe('Rows: Added (ID 2)')
  })

  it('retains numeric/string ID types and string case as distinct identities', () => {
    const changes = diff('{"Rows":[{"ID":1},{"ID":"1"},{"ID":"a"}]}', '{"Rows":[{"ID":"1"},{"ID":1},{"ID":"A"}]}')
    expect(changes.map(change => change.kind)).toEqual(['moved', 'removed', 'added'])
  })

  it('reports scalar array reorder and falls back to positional edits for duplicate or noncanonical IDs', () => {
    expect(diff('{"values":[1,2]}', '{"values":[2,1]}').map(change => change.kind)).toEqual(['changed', 'changed'])
    expect(diff('{"Rows":[{"ID":1,"x":1},{"ID":1,"x":2}]}', '{"Rows":[{"ID":1,"x":2},{"ID":1,"x":1}]}').map(change => change.path)).toEqual([['Rows', 0, 'x'], ['Rows', 1, 'x']])
    expect(diff('{"Rows":[{"id":1},{"id":2}]}', '{"Rows":[{"id":2},{"id":1}]}').map(change => change.kind)).toEqual(['changed', 'changed'])
    expect(diff('{"Rows":[{"ID":1,"Name":"First","value":1},{"ID":1,"Name":"Second"}]}', '{"Rows":[{"ID":1,"Name":"First","value":2},{"ID":1,"Name":"Second"}]}')[0].group).toBe('Rows: First (ID 1)')
  })

  it('retains positional changes when heterogeneous arrays cannot match every record by ID', () => {
    const changes = diff('{"Rows":[{"ID":1},"unknown",{"ID":2}]}', '{"Rows":["unknown",{"ID":1},{"ID":2}]}')
    expect(changes.map(change => ({ kind: change.kind, path: change.path }))).toEqual([
      { kind: 'changed', path: ['Rows', 0] },
      { kind: 'changed', path: ['Rows', 1] },
    ])
  })
})
