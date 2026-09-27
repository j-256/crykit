import { describe, expect, it } from 'vitest'
import { CORRECTIONS_FORMAT, CORRECTIONS_VERSION, MAX_CORRECTION_BYTES } from '../domain/corrections'
import { testCorrection } from '../domain/corrections.test-helpers'
import { exportCorrections, parseCorrectionCollection, readCorrections, serializeCorrectionCollection } from './corrections'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const file = (corrections: unknown[]) => ({ format: CORRECTIONS_FORMAT, version: CORRECTIONS_VERSION, exportedAt: '2026-01-02T03:04:05.000Z', corrections })

describe('corrections interchange', () => {
  it('round trips exact decisions, evidence, source revisions and explicit unknowns without profile data', () => {
    const entry = testCorrection({ evidence: 'Synthetic source URL and observation details', changes: [
      ...testCorrection().changes,
      { path: 'field', field: 'New fact', before: null, after: { state: 'unknown', reason: 'Still researching' } },
      { path: 'field', field: 'Relevant here', before: null, after: { state: 'known', value: false } },
    ] })
    expect(readCorrections(exportCorrections([entry]))).toEqual([entry])
    const payload = JSON.parse(new TextDecoder().decode(exportCorrections([entry])))
    expect(Object.keys(payload).sort()).toEqual(['corrections', 'exportedAt', 'format', 'version'])
    expect(serializeCorrectionCollection({ revision: 1, entries: [entry] })).not.toMatch(/inventory|characters|profileId|localPath/)
    expect(parseCorrectionCollection(serializeCorrectionCollection({ revision: 1, entries: [entry] }))).toEqual({ revision: 1, entries: [entry] })
  })
  it('rejects unknown properties, unsafe keys, excessive input, duplicate IDs and bad values', () => {
    const correction = testCorrection()
    for (const value of [
      { ...file([correction]), profile: { inventory: {} } },
      file([{ ...correction, localPath: 'private-source' }]),
      file([correction, correction]),
      file([{ ...correction, changes: [...correction.changes, correction.changes[0]] }]),
      file([{ ...correction, changes: [{ path: 'field', field: '__proto__', before: null, after: { state: 'known', value: 'unsafe' } }] }]),
      file([{ ...correction, confidence: 'certain' }]),
      { ...file([correction]), version: 2 },
    ]) expect(() => readCorrections(bytes(value))).toThrow()
    expect(() => readCorrections(new Uint8Array(MAX_CORRECTION_BYTES + 1))).toThrow('at most 4 MiB')
    expect(() => readCorrections(new TextEncoder().encode('{"__proto__":{}}'))).toThrow('unsafe object key')
    expect(() => readCorrections(new TextEncoder().encode('{broken'))).toThrow('valid JSON')
  })
  it('rejects circular and cross-target supersession while retaining legitimate competing proposals', () => {
    const first = testCorrection({ supersedes: ['second'] })
    const second = testCorrection({ id: 'second', supersedes: [first.id] })
    expect(() => readCorrections(bytes(file([first, second])))).toThrow()
    const other = { ...second, supersedes: [], target: { ...second.target, entityId: 'other' } }
    expect(() => readCorrections(bytes(file([first, other])))).toThrow()
    const competing = testCorrection({ id: 'independent', supersedes: [] })
    expect(readCorrections(bytes(file([testCorrection(), competing])))).toHaveLength(2)
  })
})
