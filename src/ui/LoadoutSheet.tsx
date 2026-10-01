import type { ReactNode } from 'react'
import { entityDefinitionKey } from '../domain/core'
import { changeCalculationLevel, defaultCalculation } from '../domain/calculation-plan'
import { PC_LEVEL_CAP } from '../domain/calculation-rules'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, LocalData, ObservedStat, SlotDefinition } from '../domain/types'
import { BuildMechanics } from './BuildMechanics'
import { BuildSelectionDetails } from './BuildSelectionDetails'
import { BuildStatsOverview } from './BuildStatsOverview'
import { CalculatedStats } from './CalculatedStats'
import { Segmented } from './components'
import type { DefinitionOption } from './definitions'
import { DefinitionArtwork } from './GameIcon'
import { nativeDisplayName } from '../domain/native-game'
import { Icon } from './icons'

export type LoadoutView = 'loadout' | 'checks'

export function LoadoutSelectionDetails({ option, comparedWith, showClassRatings }: { option?: DefinitionOption; comparedWith?: DefinitionOption; showClassRatings?: boolean }) {
  return option ? <BuildSelectionDetails comparedWith={comparedWith} option={option} showClassRatings={showClassRatings}/> : <p>Choose a selection to inspect its definition. Empty means nothing is equipped; Unknown means the selection has not been recorded.</p>
}

export function LoadoutSheet({ content, slots, localData, catalogs, view, onViewChange, viewLabel, classFields, equipmentFields, passiveFields, passiveTools, selection, comparedWith, notes, context, onCalculationChange, recorded, unknownInputs, unknownSecondaryClass, unknownPrimaryClass, selectionActions, allowClearCalculation = true }: {
  content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]
  view: LoadoutView; onViewChange: (view: LoadoutView) => void; viewLabel: string
  classFields: ReactNode; equipmentFields: ReactNode; passiveFields: ReactNode; passiveTools?: ReactNode
  selection?: DefinitionOption; comparedWith?: DefinitionOption; selectionActions?: ReactNode
  notes?: ReactNode; context?: ReactNode; onCalculationChange?: (plan: BuildCalculationPlan | undefined) => void
  allowClearCalculation?: boolean
  recorded?: Readonly<Record<string, ObservedStat>>; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean; unknownPrimaryClass?: boolean
}) {
  const usesDefaultLevel = content.calculation?.level == null
  const calculation = content.calculation ?? defaultCalculation(content.primaryClass)
  const displayedContent = usesDefaultLevel ? { ...content, calculation: changeCalculationLevel(calculation, PC_LEVEL_CAP, content.primaryClass) } : content
  return <div className="stack loadout-sheet">
    <div className="build-sheet__view-switch"><Segmented label={viewLabel} onChange={onViewChange} options={[{ value: 'loadout', label: 'Loadout' }, { value: 'checks', label: 'Checks & notes' }]} value={view}/></div>
    {view === 'loadout' ? <>
      <div className="build-sheet__layout">
        <div className="build-sheet__slots">
          <BuildStatsOverview catalogs={catalogs} content={displayedContent} localData={localData} onCalculationChange={onCalculationChange} slots={slots} usesDefaultLevel={usesDefaultLevel} unknownPrimaryClass={unknownPrimaryClass} unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass}/>
          <section aria-label="Class and command" className="build-sheet__group"><h3><Icon name="crystal"/>Class & command</h3>{classFields}</section>
          <section aria-label="Equipment" className="build-sheet__group"><h3><Icon name="sword"/>Equipment</h3><div className="build-sheet__equipment">{equipmentFields}</div></section>
          <section aria-label="Passives" className="build-sheet__group"><h3><Icon name="spark"/>Equipped passives</h3>{passiveTools}<div className="build-sheet__passives">{passiveFields}</div></section>
        </div>
        {selection && <aside aria-label="Selection details" className="build-sheet__preview">
          <span className="eyebrow">Selection details</span>
          <h3 className="icon-label"><DefinitionArtwork catalogs={catalogs} localData={localData} value={selection.ref}/>{nativeDisplayName(selection.record)}</h3>
          <LoadoutSelectionDetails comparedWith={comparedWith} option={selection} showClassRatings={!content.primaryClass || entityDefinitionKey(selection.ref) !== entityDefinitionKey(content.primaryClass)}/>{selectionActions}
        </aside>}
      </div>
      {context}
      <CalculatedStats catalogs={catalogs} content={displayedContent} localData={localData} onChange={onCalculationChange} recorded={recorded} slots={slots} unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass}/>
    </> : <section aria-label="Build checks and notes" className="build-sheet__checks stack">
      {unknownInputs?.length ? <p className="field__hint">Equipment checks cover known selections only. Unrecorded selections remain unknown.</p> : null}
      {usesDefaultLevel && <p className="field__hint">Level {PC_LEVEL_CAP} assumed for preview.</p>}
      <BuildMechanics allowClearCalculation={allowClearCalculation} catalogs={catalogs} content={displayedContent} localData={localData} onChange={onCalculationChange} slots={slots}/>
      {notes}
    </section>}
  </div>
}
