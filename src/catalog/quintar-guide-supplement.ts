// Landmark directions and route selection supplement the native mechanics and exact record bindings
// Keep this small guide-specific source separate from the native catalog and its gameplay evidence
export const QUINTAR_GUIDE_SUPPLEMENT = Object.freeze({
  source: {
    sourceId: 'https://crystal-project.fandom.com/wiki/Quintar_Breeding?oldid=13333',
    revision: '13333',
    locator: 'Starting quintars and Method 2',
  },
  instructions: {
    babel: 'Take a swimming mount to the Quintar Mausoleum under the Quintar Reserve. Solve its switch puzzles and collect Babel Quintar.',
    ocarina: 'Buy the Ocarina from the quintar shopkeeper in Dione Shrine.',
    trustyBlue: 'Find a Trusty Blue east of Yamagawa M.A. or northwest of Dione Shrine. Defeat it, send its egg to the nursery, and hatch it.',
    trustyRed: 'Find a Trusty Red in the Overpass northwest of Okimoto N.S. or north of Sara Sara Beach. Defeat it, send its egg to the nursery, and hatch it.',
    wokeRiver: "Find a Woke River northwest of the River Cat's Ego or northwest of Triton Shrine. Defeat it, send its egg to the nursery, and hatch it.",
    brutishDesert: 'Find a Brutish Desert in the nests northeast or northwest of Sara Sara Bazaar. Defeat it, send its egg to the nursery, and hatch it.',
  },
  // Native map markers independently bind these encounters and rewards to exact game records
  placements: {
    trustyBlue: { monsterID: 317, entityIDs: [3580, 3599] },
    trustyRed: { monsterID: 304, entityIDs: [3588, 3596, 3617] },
    wokeRiver: { monsterID: 318, entityIDs: [3592, 3594] },
    brutishDesert: { monsterID: 316, entityIDs: [3584, 3586] },
    babel: { itemID: 167, entityIDs: [2153] },
    ocarina: { itemID: 115, entityIDs: [2227] },
  },
})

// The recovery pickup is a later native release fix, separate from the attributed community route
export const BABEL_RANDOMIZER_VERSION_NOTE = 'Switch 1.6.6 randomizers can make Babel Quintar unobtainable. PC 1.6.7 adds a recovery pickup near the entrance to Dione Shrine for affected seeds.'
export const BABEL_RECOVERY_ENTITY_ID = 729
