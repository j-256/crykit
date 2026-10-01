export function syntheticCrystalEdit() {
  return { ID: 'synthetic-project', Title: 'Synthetic class export', Version: '1.0', EditorVersion: 34, Jobs: [{ ID: 40, Name: 'Synthetic Scholar', AbilitiesName: 'Synthetic Research', HPRating: 70, MPRating: 20, EquipmentTypes: [0, 11, 18, 99], AbilityIDs: [8, 9], PassiveIDs: [2], LearnTree: [
    [{ NodeType: 2, DataID: 8, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }, { NodeType: 1, DataID: 0, PrereqLeft: false, PrereqMiddle: true, PrereqRight: false }],
    [{ NodeType: 0, DataID: 0, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }, { NodeType: 3, DataID: 2, PrereqLeft: true, PrereqMiddle: false, PrereqRight: false }],
  ] }], Abilities: [{ ID: 8, Name: 'Synthetic Spark', Description: '<script>throw Error("inert")</script>' }], Passives: [], System: { Unrecognized: true } }
}

export function syntheticPrerequisiteCrystalEdit() {
  const original = syntheticCrystalEdit()
  const node = (NodeType: number, DataID: number, PrereqLeft = false, PrereqMiddle = false, PrereqRight = false) => ({ NodeType, DataID, PrereqLeft, PrereqMiddle, PrereqRight })
  return { ...original, ID: 'synthetic-prerequisite-project', Jobs: [{ ...original.Jobs[0]!, AbilityIDs: [8, 9, 10, 11], PassiveIDs: [2], LearnTree: [
    [node(2, 8), node(2, 11, false, true, true)],
    [node(2, 9), node(2, 10, true, true, true)],
    [node(3, 2), node(0, 0)],
  ] }], Abilities: [{ ID: 8, Name: 'Synthetic Spark' }, { ID: 9, Name: 'Synthetic Focus' }, { ID: 10, Name: 'Synthetic Fusion' }, { ID: 11, Name: 'Synthetic Combination' }], Passives: [{ ID: 2, Name: 'Synthetic Calm' }] }
}
