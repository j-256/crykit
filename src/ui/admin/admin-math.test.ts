import { describe, expect, it } from 'vitest'
import { capacity, exactUnitValue, parseUnitBytes, parseUnitBytesDetailed, storageDistribution } from './admin-math'
import { parseAdminRoute, routeHash } from './admin-route'

describe('capacity controls', () => {
  it('converts decimal units to whole bytes, rounding fractional bytes upward', () => {
    expect(parseUnitBytes('2.5', 'KiB')).toBe(2560)
    expect(parseUnitBytes('1.5', 'MiB')).toBe(1572864)
    expect(parseUnitBytes('.5', 'KiB')).toBe(512)
    expect(parseUnitBytes('2.', 'Bytes')).toBe(2)
    expect(parseUnitBytesDetailed('2.6', 'KiB')).toEqual({ bytes: 2663, error: null, roundedFrom: '2662.4' })
    expect(parseUnitBytesDetailed('2.5', 'Bytes')).toEqual({ bytes: 3, error: null, roundedFrom: '2.5' })
    expect(parseUnitBytesDetailed('0.1', 'KiB')).toEqual({ bytes: 103, error: null, roundedFrom: '102.4' })
    expect(parseUnitBytesDetailed('0.1', 'Bytes')).toEqual({ bytes: 1, error: null, roundedFrom: '0.1' })
    expect(parseUnitBytesDetailed('2.5', 'GiB')).toEqual({ bytes: 2684354560, error: null })
    expect(parseUnitBytesDetailed('9007199254740992', 'Bytes')).toEqual({ bytes: null, error: 'unsafe' })
    expect(parseUnitBytesDetailed('9007199254740991.1', 'Bytes')).toEqual({ bytes: null, error: 'unsafe' })
    expect(parseUnitBytesDetailed('9007199254740990.1', 'Bytes')).toEqual({ bytes: Number.MAX_SAFE_INTEGER, error: null, roundedFrom: '9007199254740990.1' })
  })
  it('round trips the largest safe byte count through every unit', () => {
    for (const unit of ['Bytes', 'KiB', 'MiB', 'GiB'] as const) {
      expect(parseUnitBytes(exactUnitValue(Number.MAX_SAFE_INTEGER, unit), unit)).toBe(
        Number.MAX_SAFE_INTEGER,
      )
    }
  })
  it('rejects unsafe values and excess input without truncating them', () => {
    expect(parseUnitBytes('0.0001', 'KiB')).toBe(1)
    expect(parseUnitBytes('9007199254740992', 'Bytes')).toBeNull()
    expect(parseUnitBytes('1'.repeat(80), 'Bytes')).toBeNull()
    expect(parseUnitBytes('-1', 'Bytes')).toBeNull()
    expect(parseUnitBytes('Infinity', 'Bytes')).toBeNull()
  })
})

describe('capacity observations', () => {
  it('keeps unknown, zero and over-capacity distinct', () => {
    expect(capacity(null, 100).percent).toBeNull()
    expect(capacity(0, 0).percent).toBeNull()
    expect(capacity(0, 0)).toMatchObject({ barPercent: 0, over: false })
    expect(capacity(1, 0)).toMatchObject({
      percent: null,
      barPercent: 100,
      over: true,
    })
    expect(capacity(0, 100).percent).toBe(0)
    expect(capacity(125, 100)).toMatchObject({
      percent: 125,
      barPercent: 100,
      over: true,
    })
  })
})

describe('accounted storage distribution', () => {
  it('uses only known positive disjoint counters', () => {
    expect(storageDistribution(null)).toBeNull()
    expect(
      storageDistribution({ payload_bytes: 0, reserved_metadata: 0, metadata_bytes: 0 }),
    ).toBeNull()
    expect(
      storageDistribution({ payload_bytes: 25, reserved_metadata: 25, metadata_bytes: 50 }),
    ).toEqual([25, 25, 50])
    expect(
      storageDistribution({ payload_bytes: -1, reserved_metadata: 1, metadata_bytes: 1 }),
    ).toBeNull()
  })
})

describe('admin hash routes', () => {
  const id = 'AQEBAQEBAQEBAQEBAQEBAQ'
  it('accepts only supported sections and opaque detail targets', () => {
    expect(parseAdminRoute(routeHash('accounts', 'accountId', id))).toEqual({
      section: 'accounts',
      target: id,
    })
    expect(parseAdminRoute('#jobs?jobId=../../settings')).toEqual({
      section: 'jobs',
      target: null,
    })
    expect(parseAdminRoute('#settings?accountId=' + id)).toEqual({
      section: 'settings',
      target: null,
    })
    expect(parseAdminRoute('#jobs?jobId=' + id + '&jobId=' + id)).toEqual({
      section: 'jobs',
      target: null,
    })
    expect(parseAdminRoute('#accounts?accountId=' + id + '?extra')).toEqual({
      section: 'accounts',
      target: null,
    })
    expect(parseAdminRoute('#unexpected')).toEqual({
      section: 'overview',
      target: null,
    })
  })
})
