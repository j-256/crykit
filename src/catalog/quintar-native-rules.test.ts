import { describe, expect, it } from 'vitest'
import nativeData from './native-game-data.json'
import codeEvidence from './game-code-evidence.json'
import { QUINTAR_NATIVE_EVIDENCE, QUINTAR_PARTNER_RACE_WINS, quintarOffspring, type QuintarNature, type QuintarTraits, type QuintarType } from './quintar-native-rules'

const quintar = (nature: QuintarNature, type: QuintarType): QuintarTraits => ({ nature, type })

describe('reviewed Windows Quintar rules', () => {
  it('binds receipts, native type vocabulary, food identities, and hatching to the inspected build', () => {
    const receipt = QUINTAR_NATIVE_EVIDENCE
    expect(receipt.source).toMatchObject({ platform: codeEvidence.source.platform, gameVersion: codeEvidence.source.gameVersion, executableSha256: codeEvidence.source.executableSha256, systemDataSha256: codeEvidence.source.systemDataSha256 })
    for (const [file, hash] of Object.entries(codeEvidence.files)) if (file in receipt.files) expect(receipt.files[file as keyof typeof receipt.files]).toBe(hash)
    const vocabulary = nativeData.databases.system.Vocab.General
    for (const [type, nativeType] of Object.entries(receipt.nativeTypeNames)) expect(vocabulary[`QUINTAR_Type_${nativeType}` as keyof typeof vocabulary]).toBe(type === 'Gold' ? 'Golden' : type)
    for (const food of receipt.food) expect(nativeData.databases.item.find(item => item?.ID === food.itemID)?.Name).toBe(food.name)
    expect(nativeData.databases.item.find(item => item?.ID === receipt.incubatorItemID)?.Name).toBe('Incubator')
    expect(receipt.readiness.status).toBe(vocabulary.QUINTAR_STATUS_HAPPY)
  })

  it.each([
    [quintar('Trusty', 'Red'), quintar('Woke', 'River'), quintar('Fancy', 'Red')],
    [quintar('Fancy', 'Red'), quintar('Woke', 'Blue'), quintar('Brutish', 'Highland')],
    [quintar('Fancy', 'Desert'), quintar('Woke', 'River'), quintar('Brutish', 'Black')],
    [quintar('Fancy', 'River'), quintar('Trusty', 'Desert'), quintar('Woke', 'Desert')],
    [quintar('Fancy', 'Highland'), quintar('Woke', 'River'), quintar('Brutish', 'Aqua')],
    [quintar('Fancy', 'River'), quintar('Trusty', 'Highland'), quintar('Woke', 'Highland')],
    [quintar('Fancy', 'Black'), quintar('Woke', 'Aqua'), quintar('Brutish', 'Gold')],
    [quintar('Brutish', 'Black'), quintar('Woke', 'Aqua'), quintar('Woke', 'Black')],
    [quintar('Fiendish', 'Blue'), quintar('Brutish', 'Red'), quintar('Fiendish', 'Red')],
    [quintar('Brutish', 'Red'), quintar('Trusty', 'Blue'), quintar('Brutish', 'Red')],
    [quintar('Trusty', 'Red'), quintar('Fancy', 'River'), quintar('Woke', 'Red')],
  ])('preserves type and nature precedence for %o and %o', (first, second, expected) => {
    expect(quintarOffspring(first, second)).toEqual(expected)
    expect(quintarOffspring(second, first)).toEqual(expected)
  })

  it('rejects matching natures across every native type, including different-colored parents', () => {
    const types = Object.keys(QUINTAR_PARTNER_RACE_WINS) as QuintarType[]
    const natures: QuintarNature[] = ['Fiendish', 'Brutish', 'Woke', 'Fancy', 'Trusty']
    for (const nature of natures) for (const first of types) for (const second of types) expect(quintarOffspring(quintar(nature, first), quintar(nature, second))).toBeUndefined()
  })
})
