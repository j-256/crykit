import { useMemo, useState } from 'react'
import { entityDefinitionKey, logicalEntityKey, validateBuildContent } from '../domain'
import { definitionModAvailability, modAvailabilityLabel } from '../catalog/mods'
import { equipmentFacts, equipmentRole, isWeapon, passivePointCost } from '../domain/mechanics-facts'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { moneyTextLabel } from '../domain/money'
import type { BuildPpValidity } from '../domain/build-validity'
import type { BuildRevisionContent, CatalogSnapshot, EntityRef, LocalData, GameSetupRevision, SlotDefinition } from '../domain/types'
import { buildDefinitionOptions, findDefinitionOption } from './definitions'
import { subCommandLabel } from './definition-fields'
import { BuildSelectionDetails } from './BuildSelectionDetails'
import { Sheet } from './Sheet'
import { DefinitionModLabel } from './DefinitionModLabel'
import { DefinitionArtwork } from './GameIcon'
import { summaryFactLines } from './build-evidence'
import { Icon, type IconName } from './icons'
import { entityName, resolveEntity } from './model'
import { Button } from './components'

const EMPTY_BUILD_CONTENT: BuildRevisionContent = Object.freeze({
  primaryClass: null,
  secondaryClass: null,
  equipment: {},
  passives: [],
  contextAssumptions: [],
})
const MAX_PASSIVE_CAPACITY_CRYSTALS = 20

function equipmentIcon(role: SlotDefinition['equipmentRole']): IconName {
  if (role === 'mainHand') return 'sword'
  if (role === 'offHand') return 'shield'
  if (role === 'head') return 'character'
  if (role === 'body') return 'chest'
  if (role === 'accessory') return 'ring'
  return 'box'
}

function SummarySelection({ label, value, localData, catalogs, gameSetup, empty, compact = false, hideLabel = false, showModLabels = true, emptyIcon, role, occupiedBy, occupiedValue, onActivate, displayName }: { label: string; value?: EntityRef | null; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; empty: string; compact?: boolean; hideLabel?: boolean; showModLabels?: boolean; emptyIcon?: IconName; role?: SlotDefinition['equipmentRole']; occupiedBy?: string; occupiedValue?: EntityRef; onActivate?: () => void; displayName?: string }) {
  const name = value ? displayName ?? entityName(localData, catalogs, value) : occupiedBy ? `Occupied by ${occupiedBy}` : empty
  const definition = value ? resolveEntity(localData, catalogs, value) : undefined
  const subCommand = label === 'Sub-command'
  const facts = definition && !subCommand ? summaryFactLines(definition).slice(0, 5) : []
  const equipment = definition && (role === 'mainHand' || role === 'offHand') ? equipmentFacts(definition) : undefined
  const handUse = equipment?.type && isWeapon(equipment.type) ? equipment.twoHanded === false ? 'One-handed' : equipment.twoHanded === true ? 'Two-handed' : 'Hand use unknown' : undefined
  const availability = value ? modAvailabilityLabel(definitionModAvailability(localData, value, gameSetup, catalogs)) : undefined
  const occupancy = occupiedBy ? `Unavailable while ${occupiedBy} occupies both hands` : undefined
  const tooltip = moneyTextLabel([`${label}: ${name}`, ...(handUse ? [handUse] : []), ...facts, ...(occupancy ? [occupancy] : []), ...(availability ? [availability] : [])].join('\n'))
  const content = <>
    {value ? <DefinitionArtwork catalogs={catalogs} localData={localData} value={value}/> : occupiedValue ? <DefinitionArtwork catalogs={catalogs} localData={localData} value={occupiedValue}/> : emptyIcon ? <Icon className="build-card__selection-empty-icon" data-empty-slot-icon={emptyIcon} name={emptyIcon}/> : <span aria-hidden="true" className="build-card__selection-placeholder">?</span>}
    {compact ? <span className="sr-only">{name}</span> : <span><small className={hideLabel ? 'sr-only' : undefined}>{label}</small><span className="definition-badge-heading"><span className="build-card__selection-name">{name}</span>{showModLabels && <DefinitionModLabel localData={localData} gameSetup={gameSetup} value={value}/>}</span></span>}
  </>
  const shared = { className: 'build-card__selection', 'data-compact': compact || undefined, 'data-empty': !value && !occupiedBy || undefined, 'data-occupied-by-two-handed': occupiedBy || undefined, 'data-tooltip': tooltip, title: tooltip }
  return onActivate
    ? <button {...shared} aria-label={`Open ${label}: ${name}`} onClick={event => { event.stopPropagation(); onActivate() }} type="button">{content}</button>
    : <span {...shared} aria-label={`${label}: ${name}`} role="group">{content}</span>
}

export function buildPpSummary(pp: BuildPpValidity): string {
  const subtotal = `${pp.knownSubtotal}${pp.unresolvedCosts ? ` + ${pp.unresolvedCosts} unresolved` : ''}`
  if (pp.limit.state === 'known') return `${subtotal} of ${pp.limit.value} PP used across passives`
  if (pp.limit.state === 'conflicting') return `${subtotal} PP used / conflicting shared limit`
  if (pp.limit.state === 'notApplicable') return `${subtotal} PP used / no shared limit applies`
  return `${subtotal} PP used / unknown shared limit`
}

export function PassiveCapacityMeter({ pp, announce = false }: { pp: BuildPpValidity; announce?: boolean }) {
  const limit = pp.limit.state === 'known' ? Math.max(0, pp.limit.value) : undefined
  const summary = buildPpSummary(pp)
  const compactSummary = limit === undefined ? `${pp.knownSubtotal}${pp.unresolvedCosts ? ` + ${pp.unresolvedCosts}?` : ''} PP` : `${pp.knownSubtotal}${pp.unresolvedCosts ? ` + ${pp.unresolvedCosts}?` : ''} / ${limit} PP`
  return <span aria-label={announce ? 'Build PP summary' : `Passive capacity: ${summary}`} className="passive-capacity" role={announce ? 'status' : 'img'}>
    {limit !== undefined && limit <= MAX_PASSIVE_CAPACITY_CRYSTALS && <span aria-hidden="true" className="passive-capacity__crystals">{Array.from({ length: limit }, (_, index) => <Icon className={index < pp.knownSubtotal ? 'is-lit' : undefined} key={index} name="crystal"/>)}</span>}
    <small aria-hidden="true">{compactSummary}</small>
  </span>
}

export function BuildLoadoutSummary({ content = EMPTY_BUILD_CONTENT, localData, catalogs, gameSetup, announcePp = false, onEquipmentSelect, onEquipmentEdit, equipmentNames = false, showClasses = true, showModLabels = true }: { content?: BuildRevisionContent; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; announcePp?: boolean; onEquipmentSelect?: (slotId: string) => void; onEquipmentEdit?: (slotId: string) => void; equipmentNames?: boolean; showClasses?: boolean; showModLabels?: boolean }) {
  const [inspectedSlotId, setInspectedSlotId] = useState<string>()
  const slots = [...(gameSetup?.slots.length ? gameSetup.slots : SUGGESTED_BUILD_SLOTS)].sort((left, right) => left.order - right.order)
  const mainHandSlot = slots.find(slot => equipmentRole(slot) === 'mainHand')
  const mainHandSelection = mainHandSlot ? content.equipment[mainHandSlot.id] : undefined
  const mainHandDefinition = mainHandSelection ? resolveEntity(localData, catalogs, mainHandSelection.ref) : undefined
  const twoHandedMain = mainHandDefinition && mainHandSelection && equipmentFacts(mainHandDefinition).twoHanded === true ? { name: mainHandDefinition.name, value: mainHandSelection.ref } : undefined
  const inspectedSlot = slots.find(slot => slot.id === inspectedSlotId)
  const inspectedSelection = inspectedSlot ? content.equipment[inspectedSlot.id] : undefined
  const inspectedOccupied = inspectedSlot && equipmentRole(inspectedSlot) === 'offHand' && twoHandedMain && (!inspectedSelection || Boolean(inspectedSelection.allocationId && inspectedSelection.allocationId === mainHandSelection?.allocationId)) ? twoHandedMain : undefined
  const inspectedRef = inspectedOccupied?.value ?? inspectedSelection?.ref
  const inspectedOption = useMemo(() => inspectedRef ? findDefinitionOption(buildDefinitionOptions({ ...localData, planningGameSetupRevisionId: gameSetup?.id }, catalogs), inspectedRef) : undefined, [inspectedRef, localData, gameSetup?.id, catalogs])
  const secondary = content.secondaryClass ? resolveEntity(localData, catalogs, content.secondaryClass) : undefined
  const report = validateBuildContent(content, gameSetup, slots, ref => resolveEntity(localData, catalogs, ref), ref => logicalEntityKey(localData, ref))
  const invalidIssues = report.issues.filter(issue => issue.status === 'invalid').length
  return <span className="build-loadout-summary" data-validity={report.status}>
    {report.status === 'invalid' && <span className="build-loadout-summary__warning"><Icon name="warning"/><strong>Needs changes</strong><small>{invalidIssues} known {invalidIssues === 1 ? 'issue' : 'issues'}</small></span>}
    {showClasses && <span className="build-card__classes">
      <SummarySelection catalogs={catalogs} empty="No class selected" label="Class" localData={localData} gameSetup={gameSetup} showModLabels={showModLabels} value={content.primaryClass}/>
      <SummarySelection catalogs={catalogs} empty="No sub-command" label="Sub-command" localData={localData} gameSetup={gameSetup} showModLabels={showModLabels} value={content.secondaryClass} displayName={secondary ? subCommandLabel({ record: secondary, name: secondary.name }) : undefined}/>
    </span>}
    <span className="build-card__summary-group">
      <span className="build-card__summary-label" title="Equipment"><Icon name="sword"/><span className="sr-only">Equipment</span></span>
      <span aria-label="Equipment" className="build-card__equipment" data-show-names={equipmentNames || undefined} role="group">{slots.map(slot => {
        const role = equipmentRole(slot)
        const selection = content.equipment[slot.id]
        const occupiedBy = role === 'offHand' ? twoHandedMain : undefined
        const sharedMainHandCopy = Boolean(occupiedBy && selection?.allocationId && selection.allocationId === mainHandSelection?.allocationId)
        return <SummarySelection catalogs={catalogs} compact={!equipmentNames} empty="Empty" emptyIcon={equipmentIcon(role)} key={slot.id} label={slot.label} occupiedBy={occupiedBy?.name} occupiedValue={!selection || sharedMainHandCopy ? occupiedBy?.value : undefined} onActivate={onEquipmentSelect ? () => onEquipmentSelect(slot.id) : () => setInspectedSlotId(slot.id)} localData={localData} role={role} gameSetup={gameSetup} showModLabels={showModLabels} value={sharedMainHandCopy ? null : selection?.ref}/>
      })}</span>
    </span>
    <span className="build-card__summary-group">
      <span className="build-card__summary-label" title="Passives"><Icon name="crystal"/><span className="sr-only">Passives</span></span>
      <PassiveCapacityMeter announce={announcePp} pp={report.pp}/>
      {content.passives.length ? <span className="build-card__passives" role="list">{content.passives.map((selection, index) => {
        const definition = resolveEntity(localData, catalogs, selection.ref)
        const cost = definition ? passivePointCost(definition) : undefined
        return <span className="build-card__passive" key={`${entityDefinitionKey(selection.ref)}:${index}`} role="listitem"><SummarySelection catalogs={catalogs} empty="Unavailable" hideLabel label={`Equipped passive ${index + 1}`} localData={localData} gameSetup={gameSetup} showModLabels={showModLabels} value={selection.ref}/><small>{cost?.state === 'known' ? `${cost.value} PP` : '? PP'}</small></span>
      })}</span> : <small className="sr-only">No passives selected</small>}
    </span>
    <Sheet open={Boolean(inspectedSlot)} title={`${inspectedSlot?.label ?? 'Equipment'}: ${inspectedOption?.name ?? inspectedSelection?.observedName ?? 'Empty'}`} description={inspectedOccupied ? `Occupied by ${inspectedOccupied.name}; this weapon uses both hands.` : 'View equipment details.'} onClose={() => setInspectedSlotId(undefined)} footer={onEquipmentEdit && inspectedSlot && <Button onClick={() => { const slotId = inspectedSlot.id; setInspectedSlotId(undefined); onEquipmentEdit(slotId) }} type="button">Edit this slot</Button>}>
      {inspectedOption ? <BuildSelectionDetails option={inspectedOption}/> : <p>{inspectedSelection ? 'The saved equipment definition is unavailable.' : 'Nothing is equipped in this slot.'}</p>}
    </Sheet>
  </span>
}
