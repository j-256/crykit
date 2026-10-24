export function legacyCodecFixture(): unknown {
  const bytes = new ArrayBuffer(20)
  new Uint8Array(bytes).set([0, 255, 18, 52, 0, 216])
  const shared = { value: '\ud800\udfff\u0000', missing: undefined }
  const array = [, undefined, null] as unknown[]
  Object.assign(array, { extra: shared })
  const expression = /a\u0000b/giu
  expression.lastIndex = 3
  const value: Record<string, unknown> = {
    scalars: [undefined, null, false, true, -0, 0, NaN, Infinity, -Infinity, 1.5],
    array, shared, alias: shared, bytes,
    view: new DataView(bytes, 2, 8), words: new Uint16Array(bytes, 4, 3),
    date: new Date('2020-01-01'), invalidDate: new Date(NaN), expression,
    map: new Map<unknown, unknown>([[shared, array], ['second', new Set([shared, array])]]),
    plain: Object.assign(Object.create(null), { value: shared }),
    records: Array.from({ length: 300 }, (_, index) => ({ index, name: `row-${index}`, enabled: index % 2 === 0 })),
  }
  value.self = value
  return value
}
