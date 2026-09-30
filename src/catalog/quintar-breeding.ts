export const QUINTAR_GUIDE_SOURCE = 'https://crystal-project.fandom.com/wiki/Quintar_Breeding?oldid=13333'
export const QUINTAR_RACING_SOURCE = 'https://steamcommunity.com/sharedfiles/filedetails/?id=2794448715'
export const QUINTAR_NURSERY_CAPACITY = 8

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

export type QuintarBreedingStepId = typeof QUINTAR_STEP[keyof typeof QUINTAR_STEP]
export type QuintarType = 'Blue' | 'Red' | 'River' | 'Desert' | 'Highland' | 'Aqua' | 'Black' | 'Gold'
export type QuintarPhase = 'unlock' | 'capture' | 'aqua' | 'black' | 'gold'

export interface GuideQuintar {
  readonly name: string
  readonly type: QuintarType
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
  trustyBlue: { name: 'Trusty Blue', type: 'Blue' },
  trustyRed: { name: 'Trusty Red', type: 'Red' },
  wokeRiver: { name: 'Woke River', type: 'River' },
  brutishDesert: { name: 'Brutish Desert', type: 'Desert' },
  fancyRed: { name: 'Fancy Red', type: 'Red' },
  fancyBlue: { name: 'Fancy Blue', type: 'Blue' },
  wokeBlue: { name: 'Woke Blue', type: 'Blue' },
  brutishHighland: { name: 'Brutish Highland', type: 'Highland' },
  fancyHighland: { name: 'Fancy Highland', type: 'Highland' },
  brutishAqua: { name: 'Brutish Aqua', type: 'Aqua' },
  wokeAqua: { name: 'Woke Aqua', type: 'Aqua' },
  fancyDesert: { name: 'Fancy Desert', type: 'Desert' },
  brutishBlack: { name: 'Brutish Black', type: 'Black' },
  fancyBlack: { name: 'Fancy Black', type: 'Black' },
  golden: { name: 'Brutish Gold', type: 'Gold' },
} as const satisfies Record<string, GuideQuintar>)

function breed(id: QuintarBreedingStepId, phase: QuintarPhase, result: GuideQuintar, parents: readonly [GuideQuintar, GuideQuintar], requires: readonly QuintarBreedingStepId[]): QuintarBreedingStep {
  return { id, phase, title: result.type === 'Gold' ? 'Hatch Golden Quintar' : `Hatch ${result.name}`, instruction: 'Make both parents Happy!, breed them, and hatch the resulting egg.', parents, requires, result }
}

export const QUINTAR_BREEDING_STEPS: readonly QuintarBreedingStep[] = Object.freeze([
  { id: QUINTAR_STEP.babel, phase: 'unlock', title: 'Obtain Babel Quintar', instruction: 'Bring a swimming mount into the Quintar Mausoleum beneath the Quintar Reserve. Complete its switch puzzles to obtain Babel Quintar and speak with quintars.', requires: [] },
  { id: QUINTAR_STEP.ocarina, phase: 'unlock', title: 'Buy Quintar Ocarina', instruction: 'Visit the Quintar Shop inside Dione Shrine. The Ocarina costs 12 gold and calls your chosen nursery mount.', requires: [QUINTAR_STEP.babel] },
  { id: QUINTAR_STEP.trustyBlue, phase: 'capture', title: 'Hatch Trusty Blue', instruction: 'Look east of Yamagawa M.A. or northwest of Dione Shrine. Defeat a Trusty Blue, send its egg to the nursery, and hatch it.', requires: [QUINTAR_STEP.babel], result: QUINTARS.trustyBlue },
  { id: QUINTAR_STEP.trustyRed, phase: 'capture', title: 'Hatch Trusty Red', instruction: 'Look in the Overpass northwest of Okimoto N.S. or north of Sara Sara Beach. Defeat a Trusty Red, send its egg to the nursery, and hatch it.', requires: [QUINTAR_STEP.babel], result: QUINTARS.trustyRed },
  { id: QUINTAR_STEP.wokeRiver, phase: 'capture', title: 'Hatch Woke River', instruction: "Look northwest of the River Cat's Ego or northwest of Triton Shrine. Defeat a Woke River, send its egg to the nursery, and hatch it.", requires: [QUINTAR_STEP.babel], result: QUINTARS.wokeRiver },
  { id: QUINTAR_STEP.brutishDesert, phase: 'capture', title: 'Hatch Brutish Desert', instruction: 'Search the desert nests northeast or northwest of Sara Sara Bazaar. Defeat a Brutish Desert, send its egg to the nursery, and hatch it.', requires: [QUINTAR_STEP.babel], result: QUINTARS.brutishDesert },
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

export const QUINTAR_BREEDING_STEP_IDS: ReadonlySet<string> = new Set(QUINTAR_BREEDING_STEPS.map(step => step.id))

const PARTNER_RACE_WINS: Readonly<Partial<Record<QuintarType, number>>> = Object.freeze({ Blue: 0, Red: 0, River: 2, Desert: 2, Highland: 2, Black: 3, Aqua: 4 })

export function quintarRaceRequirements(step: QuintarBreedingStep): readonly { readonly name: string; readonly wins: number | undefined }[] {
  const parents = step.parents
  if (!parents) return []
  return parents.map((parent, index) => {
    const partner = parents[index === 0 ? 1 : 0]
    return { name: parent.name, wins: PARTNER_RACE_WINS[partner.type] }
  })
}

export function quintarParentsAfterStep(step: QuintarBreedingStep): { readonly keep: readonly string[]; readonly release: readonly string[] } {
  const index = QUINTAR_BREEDING_STEPS.findIndex(entry => entry.id === step.id)
  const needed = new Set(QUINTAR_BREEDING_STEPS.slice(index + 1).flatMap(entry => entry.parents?.map(parent => parent.name) ?? []))
  const parents = step.parents?.map(parent => parent.name) ?? []
  return { keep: parents.filter(name => needed.has(name)), release: parents.filter(name => !needed.has(name)) }
}
