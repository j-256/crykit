import { describe, expect, it } from 'vitest'
import { ownRecordValue } from './model'

describe('ownRecordValue', () => {
  it('accepts own prototype-shaped keys without reading inherited properties', () => {
    const record = JSON.parse('{"constructor":"own constructor","__proto__":"own prototype"}') as Record<string, string>

    expect(ownRecordValue(record, 'constructor')).toBe('own constructor')
    expect(ownRecordValue(record, '__proto__')).toBe('own prototype')
    expect(ownRecordValue({}, 'constructor')).toBeUndefined()
    expect(ownRecordValue({}, '__proto__')).toBeUndefined()
  })
})
