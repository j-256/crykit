import evidence from './quintar-native-evidence.json' with { type: 'json' }

export type QuintarType = keyof typeof evidence.partnerRaceWins
export type QuintarNature = 'Fiendish' | 'Brutish' | 'Woke' | 'Fancy' | 'Trusty'
export interface QuintarTraits {
  readonly type: QuintarType
  readonly nature: QuintarNature
}

export const QUINTAR_NATIVE_EVIDENCE = evidence
export const QUINTAR_NATIVE_SOURCE = `Crystal Project ${evidence.source.platform} PC ${evidence.source.gameVersion}`
export const QUINTAR_NURSERY_CAPACITY = evidence.nurseryCapacity
export const QUINTAR_PARTNER_RACE_WINS: Readonly<Record<QuintarType, number>> = Object.freeze(evidence.partnerRaceWins)

// CQuest resolves type and nature independently, after rejecting identical natures
export function quintarOffspring(first: QuintarTraits, second: QuintarTraits): QuintarTraits | undefined {
  if (first.nature === second.nature) return undefined
  const parents = [first, second]
  const byNature = (nature: QuintarNature) => parents.find(parent => parent.nature === nature)
  const hasTypes = (a: QuintarType, b: QuintarType) => parents.some(parent => parent.type === a) && parents.some(parent => parent.type === b)
  const fancy = byNature('Fancy')
  const brutish = byNature('Brutish')
  const fiendish = byNature('Fiendish')
  const trusty = byNature('Trusty')
  const woke = byNature('Woke')
  const type = brutish?.type ?? fiendish?.type
    ?? (fancy && hasTypes('Red', 'Blue') ? 'Highland' : undefined)
    ?? (fancy?.type === 'Desert' && hasTypes('Desert', 'River') ? 'Black' : undefined)
    ?? (fancy?.type === 'Highland' && hasTypes('Highland', 'River') ? 'Aqua' : undefined)
    ?? (hasTypes('Black', 'Aqua') ? 'Gold' : undefined)
    ?? trusty?.type ?? fancy?.type ?? woke?.type ?? 'Red'
  const otherThanBrutish = first === brutish ? second : first
  const nature = fiendish ? 'Fiendish'
    : brutish ? otherThanBrutish.nature === 'Trusty' ? 'Brutish' : otherThanBrutish.nature
      : woke && trusty ? 'Fancy'
        : fancy && trusty ? 'Woke'
          : fancy && woke ? 'Brutish' : 'Fiendish'
  return { type, nature }
}
