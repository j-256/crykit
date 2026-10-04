const DESCRIPTION_RECEIPT = 'src/catalog/native-description-evidence.json'
const MECHANICS_RECEIPT = 'src/catalog/native-mechanics.json'
const QUINTAR_RECEIPT = 'src/catalog/quintar-native-evidence.json'
const GARDENING_RECEIPT = 'src/catalog/native-gardening.json'
const ACQUISITION_RECEIPT = 'src/catalog/acquisition-route-facts.json'
export const PROJECTION_EVIDENCE = [DESCRIPTION_RECEIPT, MECHANICS_RECEIPT, QUINTAR_RECEIPT, GARDENING_RECEIPT, ACQUISITION_RECEIPT]
const HASH = /^[a-f0-9]{64}$/
const REQUIRED_FILES = {
  [DESCRIPTION_RECEIPT]: ['Sang/Window/WindowHelper.cs', 'Sang/Common/StringInterpreter.cs', 'Sang/SangData/CVocab.cs', 'Sang/SangData/HAbility.cs', 'Sang/SangData/HStatus.cs', 'Sang/Battle/StatusCollection.cs', 'Sang/Battle/StatusCount.cs'],
  [MECHANICS_RECEIPT]: ['Sang/Battle/BattlerStats.cs', 'Sang/SangData/HAbility.cs', 'Sang/Battle/Calculator.cs', 'Sang/Battle/AbilityProcessor.cs', 'Sang/Window/WindowHelper.cs'],
  [QUINTAR_RECEIPT]: ['Sang/PartyData/CQuest.cs', 'Sang/PartyData/QuestStateData.cs', 'Sang/Window/Field/Service/WindowMyQuintarHatchEgg.cs', 'Sang/Window/Field/Service/WindowMyQuintarMateSelect.cs'],
  [ACQUISITION_RECEIPT]: ['Sang/Window/Dialogue/MenuItemDialogChoice.cs', 'Sang/Window/Dialogue/WindowDialog.cs'],
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const strings = value => Array.isArray(value) && value.length > 0 && value.every(nonempty)

export function citationSourceId(value) {
  if (!record(value) || typeof value.sourceId !== 'string') return undefined
  if (typeof value.targetId === 'string' && typeof value.relation === 'string') return undefined
  if (typeof value.entityId === 'string' && record(value.expectedFields)) return undefined
  return value.sourceId
}

export function validateProjectionEvidence(file, receipt, { evidence, snapshot, combat, world, reviewedFiles }) {
  const fail = reason => { throw new Error(`${reason}: ${file}`) }
  if (!PROJECTION_EVIDENCE.includes(file) || !record(receipt)) fail('Unknown or invalid projection receipt')
  const files = {}
  const appendFiles = (values, calculation = false) => {
    if (!record(values) || Object.keys(values).length === 0) fail('Projection code files are missing')
    for (const [path, sha256] of Object.entries(values)) {
      if (typeof sha256 !== 'string' || !HASH.test(sha256) || !/^[A-Za-z0-9_/.-]+\.cs$/.test(path) || path.startsWith('/') || path.split('/').includes('..')) fail('Invalid projection code locator')
      if (files[path] && files[path] !== sha256 || reviewedFiles[path] && reviewedFiles[path] !== sha256) fail(`Projection code fingerprint differs for ${path}`)
      if (calculation && combat.source.files[path] !== sha256) fail(`Projection calculation fingerprint differs for ${path}`)
      files[path] = sha256
    }
  }
  if (file === GARDENING_RECEIPT) {
    if (!HASH.test(receipt.gameExecutableSha256 ?? '') || receipt.gameExecutableSha256 !== evidence.source.executableSha256 || !HASH.test(receipt.nativeContentDigest ?? '') || receipt.nativeContentDigest !== snapshot.contentDigest) fail('Projection source fingerprints differ')
    if (!record(receipt.code) || receipt.code.path !== 'Sang/PartyData/CQuest.cs' || !strings(receipt.code.members)) fail('Projection code evidence is missing')
    appendFiles({ [receipt.code.path]: receipt.code.sha256 })
  } else if (file === ACQUISITION_RECEIPT) {
    const source = receipt.source
    if (!record(source) || source.platform !== snapshot.source.platform || source.gameVersion !== snapshot.source.gameVersion || !HASH.test(source.gameExecutableSha256 ?? '') || source.gameExecutableSha256 !== evidence.source.executableSha256 || !HASH.test(source.nativeContentDigest ?? '') || source.nativeContentDigest !== snapshot.contentDigest || !HASH.test(source.worldContentDigest ?? '') || source.worldContentDigest !== world?.contentDigest || !HASH.test(source.worldSha256 ?? '') || source.worldSha256 !== world?.source.world.sha256) fail('Projection source fingerprints differ')
    appendFiles(receipt.files)
    if (REQUIRED_FILES[file].some(path => !Object.hasOwn(files, path))) fail('Required projection code evidence is missing')
    if (!Array.isArray(receipt.prices) || !receipt.prices.length || !receipt.prices.every(price => record(price) && nonempty(price.entityId) && record(price.expectedRoute) && nonempty(price.expectedRoute.evidence) && Number.isSafeInteger(price.price) && price.price >= 0 && record(price.choice) && Number.isSafeInteger(price.choice.entityID) && nonempty(price.choice.path) && nonempty(price.choice.answerVariableKey) && Number.isSafeInteger(price.choice.choiceIndex) && price.choice.choiceIndex >= 0 && (price.choice.explicitAnswerValue === null || Number.isSafeInteger(price.choice.explicitAnswerValue)) && price.choice.cost === price.price && price.choice.isCostOfItem === false && strings(price.evidence))) fail('Acquisition projection receipt is incomplete')
  } else {
    const source = receipt.source
    if (!record(source) || source.platform !== snapshot.source.platform || source.gameVersion !== snapshot.source.gameVersion || !HASH.test(source.executableSha256 ?? '') || source.executableSha256 !== evidence.source.executableSha256 || !HASH.test(source.systemDataSha256 ?? '') || source.systemDataSha256 !== evidence.source.systemDataSha256) fail('Projection source fingerprints differ')
    appendFiles(receipt.files)
    if (REQUIRED_FILES[file].some(path => !Object.hasOwn(files, path))) fail('Required projection code evidence is missing')
    if (file === DESCRIPTION_RECEIPT && (receipt.schemaVersion !== 1 || !HASH.test(source.contentDigest ?? '') || source.contentDigest !== snapshot.contentDigest || !strings(receipt.symbols) || !nonempty(receipt.scope))) fail('Description projection receipt is incomplete')
    if (file === QUINTAR_RECEIPT && (receipt.schemaVersion !== 1 || !record(receipt.evidence) || !Object.values(receipt.evidence).length || !Object.values(receipt.evidence).every(strings) || !nonempty(source.scope))) fail('Quintar projection receipt is incomplete')
    if (file === MECHANICS_RECEIPT) {
      if (!Array.isArray(receipt.entries) || !receipt.entries.length || !receipt.entries.every(entry => record(entry) && nonempty(entry.sourceId) && nonempty(entry.entityId) && record(entry.expectedFields) && strings(entry.evidence))) fail('Mechanic projection receipt is incomplete')
      appendFiles(receipt.calculationFiles, true)
      if (!Object.hasOwn(receipt.calculationFiles, 'Sang/Battle/RollResolver.cs')) fail('Required projection calculation evidence is missing')
    }
  }
  return { file, files, scope: receipt.scope ?? receipt.source?.scope ?? 'Fingerprint-bound native rules' }
}
