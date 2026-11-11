import { useId, useMemo, useRef, useState } from 'react'
import { logicalEntityKey, validateBuildContent } from '../domain'
import { equipmentFacts, equipmentRole } from '../domain/mechanics-facts'
import type { BuildRevision, CatalogSnapshot, LocalData, EntityRef, Knowledge } from '../domain'
import { PassiveCapacityMeter } from './BuildLoadoutSummary'
import { LoadoutSheet, type LoadoutView } from './LoadoutSheet'
import { ReadOnlyDefinitionField } from './ReadOnlyDefinitionField'
import { buildDefinitionOptions, findDefinitionOption, type DefinitionOption } from './definitions'
import { CalculationInputs } from './CalculationInputs'
import { resolveGameRules } from '../domain/game-rules'
import { KnowledgeValue } from './KnowledgeValue'
import { BuildValidity } from './BuildValidity'
import { BuildDisclosure } from './BuildDisclosure'
import { BuildModFiles } from './BuildModFiles'
import { resolveEntity } from './model'
import { buildReferenceName } from '../domain/build-reference-names'
import { focusFieldElement } from './field-focus'
import { BUILD_REVIEW_FIELDS } from './build-validity-guidance'
import { passivePosition } from '../domain/passive-loadout'

export function SharedBuild({ revision, preview, onUploadMod, onReviewSetup }: { readonly revision: BuildRevision; readonly preview: { readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }; readonly onUploadMod: () => void; readonly onReviewSetup?: () => void }) {
  const fieldScope = useId()
  const validityRef = useRef<HTMLElement>(null)
  const reviewSolutions = () => { validityRef.current?.scrollIntoView({ block: 'center' }); validityRef.current?.focus({ preventScroll: true }) }
  const { localData, catalogs } = preview
  const setup = localData.gameSetups[revision.gameSetupRevisionId]!
  const report = validateBuildContent(revision.content, setup, setup.slots, ref => resolveEntity(localData, catalogs, ref), ref => logicalEntityKey(localData, ref))
  const mainHandSlot = setup.slots.find(slot => equipmentRole(slot) === 'mainHand')
  const mainHand = mainHandSlot && revision.content.equipment[mainHandSlot.id]
  const mainHandDefinition = mainHand ? resolveEntity(localData, catalogs, mainHand.ref) : undefined
  const twoHanded = mainHandDefinition && equipmentFacts(mainHandDefinition).twoHanded === true
  const content = revision.content
  const rules = useMemo(() => resolveGameRules(setup, catalogs), [setup, catalogs])
  const slots = [...setup.slots].sort((left, right) => left.order - right.order)
  const retained = Object.keys(content.equipment).filter(id => !slots.some(slot => slot.id === id))
  const options = useMemo(() => buildDefinitionOptions({ ...localData, planningGameSetupRevisionId: setup.id }, catalogs), [localData, catalogs, setup.id])
  const [view, setView] = useState<LoadoutView>('loadout')
  const setupRef = useRef<HTMLDetailsElement>(null)
  const [inspection, setInspection] = useState<{ option?: DefinitionOption; showClassPermissions: boolean }>()
  const field = (label: string, ref: EntityRef | null | undefined, empty = 'Empty', observedName?: string, target = label === 'Class' ? BUILD_REVIEW_FIELDS.primaryClass : label === 'Sub-command' ? BUILD_REVIEW_FIELDS.secondaryClass : label) => <div data-field-key={`${fieldScope}:${target}`} tabIndex={-1}><ReadOnlyDefinitionField catalogs={catalogs} empty={ref ? buildReferenceName(content, ref) ?? observedName ?? 'Unresolved selection' : empty} gameSetup={setup} label={label} value={ref} localData={localData} onInspect={option => setInspection({ option, showClassPermissions: label !== 'Sub-command' })} option={findDefinitionOption(options, ref)}/></div>
  const equipmentField = (id: string, label: string) => {
    const selection = content.equipment[id]
    const offHand = slots.find(slot => slot.id === id && equipmentRole(slot) === 'offHand')
    const sameCopy = Boolean(selection?.allocationId && selection.allocationId === mainHand?.allocationId)
    const occupied = twoHanded && offHand && (!selection || sameCopy)
    return <div className="slot-entry" key={id}>{field(label, occupied ? undefined : selection?.ref, occupied ? `Occupied by ${mainHandDefinition.name}` : 'Empty', selection?.observedName, id)}{selection?.allocationId && <p className="field__hint">Same physical copy: {[...slots.map(slot => ({ id: slot.id as string, label: slot.label })), ...retained.map(id => ({ id, label: id }))].filter(slot => slot.id !== id && content.equipment[slot.id]?.allocationId === selection.allocationId).map(slot => slot.label).join(', ') || 'No other selected slot'}</p>}</div>
  }
  const setupFacts: readonly { label: string; value: Knowledge<unknown> }[] = [
    { label: 'Platform', value: setup.platform }, { label: 'Game version', value: setup.gameVersion }, { label: 'Mode', value: setup.mode },
    { label: 'Enabled mods', value: setup.mods }, { label: 'Disabled mods', value: setup.disabledMods ?? { state: 'unknown' } },
    { label: 'Passive PP limit', value: setup.ppLimit ?? { state: 'unknown' } }, { label: 'Nonnegative PP costs', value: setup.ppCostsNonNegative },
  ]
  const reviewSetup = onReviewSetup ?? (() => { if (setupRef.current) { setupRef.current.open = true; setupRef.current.scrollIntoView({ block: 'center' }); setupRef.current.focus() } })
  const validity = <BuildValidity unsharedSlotIds={slots.filter(slot => slot.acceptedEntityKinds === undefined).map(slot => slot.id)} panelRef={validityRef} hasPrimaryClass={Boolean(content.primaryClass)} readOnly report={report} fieldLabels={Object.fromEntries([...slots.map(slot => [slot.id, slot.label]), ...content.passives.map((_selection, index) => [passivePosition(index).id, passivePosition(index).label])])} onUploadMod={setup.modSourceReceipts?.length ? onUploadMod : undefined} onReviewField={target => { setView('loadout'); focusFieldElement(`${fieldScope}:${target === BUILD_REVIEW_FIELDS.passives ? passivePosition(0).id : target}`) }} onReviewSetup={reviewSetup}/>
  return <div className="stack build-sheet shared-build-sheet" data-validity={report.status}>
    {report.status === 'invalid' && validity}
    <LoadoutSheet readOnly onUploadMod={setup.modSourceReceipts?.length ? onUploadMod : undefined} onReviewGameSetup={reviewSetup} onReviewIssues={reviewSolutions} gameSetup={setup} catalogs={catalogs} content={content} localData={localData} slots={slots} view={view} onViewChange={setView} viewLabel="Shared build view" selection={inspection ? inspection.option : findDefinitionOption(options, content.primaryClass)} showClassPermissions={inspection?.showClassPermissions}
      primaryClassField={field('Class', content.primaryClass, 'No class selected')} subCommandField={field('Sub-command', content.secondaryClass, 'No sub-command')}
      equipmentFields={<>{slots.map(slot => equipmentField(slot.id, slot.label))}{retained.length > 0 && <div><p className="field__hint">These selections use slots outside this Game Setup.</p>{retained.map(id => equipmentField(id, id))}</div>}</>}
      passiveTools={<PassiveCapacityMeter pp={report.pp}/>}
      passiveFields={content.passives.length ? content.passives.map((selection, index) => <div key={index}>{field(`Equipped passive ${index + 1}`, selection.ref, 'Empty', selection.observedName, passivePosition(index).id)}</div>) : <p>No passives equipped.</p>}
      notes={<>{content.calculation && <BuildDisclosure label="Calculation inputs"><CalculationInputs catalogs={catalogs} localData={localData} plan={content.calculation} genders={rules.genders}/></BuildDisclosure>}{(revision.note || content.rotationNotes || content.contextAssumptions.length > 0) && <BuildDisclosure label="Build notes and assumptions"><div className="share-notes">{revision.note && <p>{revision.note}</p>}{content.rotationNotes && <p>{content.rotationNotes}</p>}{content.contextAssumptions.map((note, index) => <p key={index}>{note}</p>)}</div></BuildDisclosure>}</>}
    />
    {report.status !== 'invalid' && validity}
    {!onReviewSetup && <><BuildModFiles setup={setup} catalogs={catalogs} onOpen={onUploadMod}/><BuildDisclosure ref={setupRef} tabIndex={-1} label={`Game Setup: ${setup.label}`}><dl className="definition-list">{setupFacts.map(({ label, value }) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue showSources value={value}/></dd></div>)}</dl></BuildDisclosure></>}
  </div>
}
