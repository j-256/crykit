import { QUINTAR_PARTNER_RACE_WINS, quintarOffspring, type QuintarNature, type QuintarTraits, type QuintarType } from './quintar-native-rules'
import { QUINTAR_GUIDE_SUPPLEMENT } from './quintar-guide-supplement'
export { QUINTAR_NURSERY_CAPACITY } from './quintar-native-rules'
export type { QuintarType } from './quintar-native-rules'

export const QUINTAR_GUIDE_SOURCE = QUINTAR_GUIDE_SUPPLEMENT.source.sourceId

export const QUINTAR_STEP = Object.freeze({
  babel: 'babel',
  ocarina: 'ocarina',
  trustyBlue: 'trusty-blue',
  trustyRed: 'trusty-red',
  wokeRiver: 'woke-river',
  brutishDesert: 'brutish-desert',
  fancyRed: 'fancy-red',
  fancyBlue: 'fancy-blue',
  wokeBlue: 'woke-blue',
  brutishHighland: 'brutish-highland',
  fancyHighland: 'fancy-highland',
  brutishAqua: 'brutish-aqua',
  wokeAqua: 'woke-aqua',
  fancyDesert: 'fancy-desert',
  brutishBlack: 'brutish-black',
  fancyBlack: 'fancy-black',
  golden: 'golden',
  summon: 'summon',
} as const)

export type QuintarBreedingStepId = typeof QUINTAR_STEP[keyof typeof QUINTAR_STEP] | `native-pairing-v1:${string}`
export type QuintarPhase = 'unlock' | 'capture' | 'aqua' | 'black' | 'gold'

export interface GuideQuintar extends QuintarTraits {
  readonly name: string
}

export interface QuintarBreedingStep {
  readonly id: QuintarBreedingStepId
  readonly phase: QuintarPhase
  readonly title: string
  readonly instruction: string
  readonly requires: readonly QuintarBreedingStepId[]
  readonly result?: GuideQuintar
  readonly parents?: readonly [GuideQuintar, GuideQuintar]
}

export const QUINTAR_PHASES = Object.freeze([
  { id: 'unlock', title: 'Unlock the nursery', description: 'Reach Dione Shrine and prepare your tools.' },
  { id: 'capture', title: 'Collect your starting eggs', description: 'Defeat these wild quintars, send their eggs to the nursery, then hatch them.' },
  { id: 'aqua', title: 'Breed your Aqua parent', description: 'Follow the pairings in order. Keep Fancy Red and Woke River for the Black branch too.' },
  { id: 'black', title: 'Breed your Black parent', description: 'Keep Woke Aqua while you complete the second branch.' },
  { id: 'gold', title: 'Finish your Golden Quintar', description: 'Combine both parents and set your new mount to the Ocarina.' },
] as const)

const QUINTARS = Object.freeze({
  trustyBlue: { name: 'Trusty Blue', type: 'Blue', nature: 'Trusty' },
  trustyRed: { name: 'Trusty Red', type: 'Red', nature: 'Trusty' },
  wokeRiver: { name: 'Woke River', type: 'River', nature: 'Woke' },
  brutishDesert: { name: 'Brutish Desert', type: 'Desert', nature: 'Brutish' },
  fancyRed: { name: 'Fancy Red', type: 'Red', nature: 'Fancy' },
  fancyBlue: { name: 'Fancy Blue', type: 'Blue', nature: 'Fancy' },
  wokeBlue: { name: 'Woke Blue', type: 'Blue', nature: 'Woke' },
  brutishHighland: { name: 'Brutish Highland', type: 'Highland', nature: 'Brutish' },
  fancyHighland: { name: 'Fancy Highland', type: 'Highland', nature: 'Fancy' },
  brutishAqua: { name: 'Brutish Aqua', type: 'Aqua', nature: 'Brutish' },
  wokeAqua: { name: 'Woke Aqua', type: 'Aqua', nature: 'Woke' },
  fancyDesert: { name: 'Fancy Desert', type: 'Desert', nature: 'Fancy' },
  brutishBlack: { name: 'Brutish Black', type: 'Black', nature: 'Brutish' },
  fancyBlack: { name: 'Fancy Black', type: 'Black', nature: 'Fancy' },
  golden: { name: 'Brutish Gold', type: 'Gold', nature: 'Brutish' },
} as const satisfies Record<string, GuideQuintar>)

// These exact native monster identities keep the guide's four starting quintars distinct
export const QUINTAR_STARTING_QUINTARS = Object.freeze([
  { id: QUINTAR_STEP.trustyBlue, monsterID: 317, result: QUINTARS.trustyBlue },
  { id: QUINTAR_STEP.trustyRed, monsterID: 304, result: QUINTARS.trustyRed },
  { id: QUINTAR_STEP.wokeRiver, monsterID: 318, result: QUINTARS.wokeRiver },
  { id: QUINTAR_STEP.brutishDesert, monsterID: 316, result: QUINTARS.brutishDesert },
])

function breed(id: QuintarBreedingStepId, phase: QuintarPhase, result: GuideQuintar, parents: readonly [GuideQuintar, GuideQuintar], requires: readonly QuintarBreedingStepId[]): QuintarBreedingStep {
  const nativeResult = quintarOffspring(...parents)
  if (nativeResult?.type !== result.type || nativeResult.nature !== result.nature) throw new Error(`Quintar route pairing disagrees with the native rules: ${id}`)
  return { id, phase, title: result.type === 'Gold' ? 'Hatch Golden Quintar' : `Hatch ${result.name}`, instruction: 'Make both parents Happy!, breed them, and hatch the resulting egg.', parents, requires, result }
}

// Route order follows the attributed supplement; every pairing is checked against native outcomes
export const QUINTAR_BREEDING_STEPS: readonly QuintarBreedingStep[] = Object.freeze([
  { id: QUINTAR_STEP.babel, phase: 'unlock', title: 'Obtain Babel Quintar', instruction: QUINTAR_GUIDE_SUPPLEMENT.instructions.babel, requires: [] },
  { id: QUINTAR_STEP.ocarina, phase: 'unlock', title: 'Buy Quintar Ocarina', instruction: QUINTAR_GUIDE_SUPPLEMENT.instructions.ocarina, requires: [QUINTAR_STEP.babel] },
  { id: QUINTAR_STEP.trustyBlue, phase: 'capture', title: 'Hatch Trusty Blue', instruction: QUINTAR_GUIDE_SUPPLEMENT.instructions.trustyBlue, requires: [QUINTAR_STEP.babel], result: QUINTARS.trustyBlue },
  { id: QUINTAR_STEP.trustyRed, phase: 'capture', title: 'Hatch Trusty Red', instruction: QUINTAR_GUIDE_SUPPLEMENT.instructions.trustyRed, requires: [QUINTAR_STEP.babel], result: QUINTARS.trustyRed },
  { id: QUINTAR_STEP.wokeRiver, phase: 'capture', title: 'Hatch Woke River', instruction: QUINTAR_GUIDE_SUPPLEMENT.instructions.wokeRiver, requires: [QUINTAR_STEP.babel], result: QUINTARS.wokeRiver },
  { id: QUINTAR_STEP.brutishDesert, phase: 'capture', title: 'Hatch Brutish Desert', instruction: QUINTAR_GUIDE_SUPPLEMENT.instructions.brutishDesert, requires: [QUINTAR_STEP.babel], result: QUINTARS.brutishDesert },
  breed(QUINTAR_STEP.fancyRed, 'aqua', QUINTARS.fancyRed, [QUINTARS.trustyRed, QUINTARS.wokeRiver], [QUINTAR_STEP.trustyRed, QUINTAR_STEP.wokeRiver]),
  breed(QUINTAR_STEP.fancyBlue, 'aqua', QUINTARS.fancyBlue, [QUINTARS.trustyBlue, QUINTARS.wokeRiver], [QUINTAR_STEP.trustyBlue, QUINTAR_STEP.wokeRiver]),
  breed(QUINTAR_STEP.wokeBlue, 'aqua', QUINTARS.wokeBlue, [QUINTARS.fancyBlue, QUINTARS.trustyBlue], [QUINTAR_STEP.fancyBlue, QUINTAR_STEP.trustyBlue]),
  breed(QUINTAR_STEP.brutishHighland, 'aqua', QUINTARS.brutishHighland, [QUINTARS.fancyRed, QUINTARS.wokeBlue], [QUINTAR_STEP.fancyRed, QUINTAR_STEP.wokeBlue]),
  breed(QUINTAR_STEP.fancyHighland, 'aqua', QUINTARS.fancyHighland, [QUINTARS.brutishHighland, QUINTARS.fancyRed], [QUINTAR_STEP.brutishHighland, QUINTAR_STEP.fancyRed]),
  breed(QUINTAR_STEP.brutishAqua, 'aqua', QUINTARS.brutishAqua, [QUINTARS.fancyHighland, QUINTARS.wokeRiver], [QUINTAR_STEP.fancyHighland, QUINTAR_STEP.wokeRiver]),
  breed(QUINTAR_STEP.wokeAqua, 'aqua', QUINTARS.wokeAqua, [QUINTARS.brutishAqua, QUINTARS.wokeRiver], [QUINTAR_STEP.brutishAqua, QUINTAR_STEP.wokeRiver]),
  breed(QUINTAR_STEP.fancyDesert, 'black', QUINTARS.fancyDesert, [QUINTARS.brutishDesert, QUINTARS.fancyRed], [QUINTAR_STEP.brutishDesert, QUINTAR_STEP.fancyRed]),
  breed(QUINTAR_STEP.brutishBlack, 'black', QUINTARS.brutishBlack, [QUINTARS.fancyDesert, QUINTARS.wokeRiver], [QUINTAR_STEP.fancyDesert, QUINTAR_STEP.wokeRiver]),
  breed(QUINTAR_STEP.fancyBlack, 'black', QUINTARS.fancyBlack, [QUINTARS.brutishBlack, QUINTARS.fancyRed], [QUINTAR_STEP.brutishBlack, QUINTAR_STEP.fancyRed]),
  breed(QUINTAR_STEP.golden, 'gold', QUINTARS.golden, [QUINTARS.fancyBlack, QUINTARS.wokeAqua], [QUINTAR_STEP.fancyBlack, QUINTAR_STEP.wokeAqua]),
  { id: QUINTAR_STEP.summon, phase: 'gold', title: 'Summon your Golden Quintar', instruction: 'Set the hatched Golden Quintar as your Ocarina mount at the nursery, then use the Ocarina. Your mount combines speed, higher jumps, swimming, and gliding.', requires: [QUINTAR_STEP.golden, QUINTAR_STEP.ocarina] },
])

export const QUINTAR_GOLD_STEP_ID = QUINTAR_STEP.golden

function acceptedStepIds(): ReadonlySet<string> {
  const ids = new Set<string>(Object.values(QUINTAR_STEP))
  const natures: readonly QuintarNature[] = ['Fiendish', 'Brutish', 'Woke', 'Fancy', 'Trusty']
  const types = Object.keys(QUINTAR_PARTNER_RACE_WINS) as QuintarType[]
  const traits = types.flatMap(type => natures.map(nature => ({ type, nature })))
  const key = (quintar: QuintarTraits) => `${quintar.nature.toLowerCase()}-${quintar.type.toLowerCase()}`
  // Earlier generated-route observations retain their own recipe identities instead of marking this route complete
  // Preserve both parent orders used by the v1 identity contract, including recipes outside the displayed route
  for (let first = 0; first < traits.length; first++) for (let second = first + 1; second < traits.length; second++) {
    const parents = [traits[first]!, traits[second]!] as const
    const result = quintarOffspring(...parents)
    if (!result) continue
    for (const pair of [parents, [parents[1], parents[0]]]) ids.add(`native-pairing-v1:${key(result)}:${pair.map(key).join('+')}`)
  }
  return ids
}

export const QUINTAR_BREEDING_STEP_IDS = acceptedStepIds()

export function quintarRaceRequirements(step: QuintarBreedingStep): readonly { readonly name: string; readonly wins: number }[] {
  const parents = step.parents
  if (!parents) return []
  return parents.map((parent, index) => {
    const partner = parents[index === 0 ? 1 : 0]
    return { name: parent.name, wins: QUINTAR_PARTNER_RACE_WINS[partner.type] }
  })
}

export function quintarParentsAfterStep(step: QuintarBreedingStep): { readonly keep: readonly string[]; readonly release: readonly string[] } {
  const index = QUINTAR_BREEDING_STEPS.findIndex(entry => entry.id === step.id)
  if (index < 0) return { keep: [], release: [] }
  const needed = new Set(QUINTAR_BREEDING_STEPS.slice(index + 1).flatMap(entry => entry.parents?.map(parent => parent.name) ?? []))
  const parents = step.parents?.map(parent => parent.name) ?? []
  return { keep: parents.filter(name => needed.has(name)), release: parents.filter(name => !needed.has(name)) }
}
