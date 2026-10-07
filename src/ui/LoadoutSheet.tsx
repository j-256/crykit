import { useRef, type ReactNode } from 'react'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, GameSetupRevision, LocalData, ObservedStat, SlotDefinition } from '../domain/types'
import { BuildMechanics } from './BuildMechanics'
import { BuildSelectionDetails } from './BuildSelectionDetails'
import { BuildStatsOverview } from './BuildStatsOverview'
import { CalculatedStats } from './CalculatedStats'
import { Segmented } from './components'
import type { DefinitionOption } from './definitions'
import { DefinitionArtwork } from './GameIcon'
import { nativeDisplayName } from '../domain/native-game'
import { Icon } from './icons'
import { PrimaryClassGrowth } from './PrimaryClassGrowth'

export type LoadoutView = 'loadout' | 'checks'

export function LoadoutSelectionDetails({ option, comparedWith, catalogs, localData, gameSetup, showIdentity, showClassPermissions }: { option?: DefinitionOption; comparedWith?: DefinitionOption; catalogs?: readonly CatalogSnapshot[]; localData?: LocalData; gameSetup?: GameSetupRevision; showIdentity?: boolean; showClassPermissions?: boolean }) {
  return option ? <BuildSelectionDetails catalogs={catalogs} comparedWith={comparedWith} gameSetup={gameSetup} localData={localData} option={option} showClassPermissions={showClassPermissions} showIdentity={showIdentity}/> : <p>Select a class, item, or passive for details. Empty means nothing is equipped; Unknown means it has not been recorded.</p>
}

export function LoadoutSheet({ content, slots, localData, catalogs, gameSetup, view, onViewChange, viewLabel, primaryClassField, subCommandField, equipmentFields, passiveFields, passiveTools, selection, comparedWith, notes, context, onCalculationChange, onReviewGameSetup, recorded, unknownInputs, unknownSecondaryClass, unknownPrimaryClass, selectionActions, showClassPermissions, showChecks = true, showStats = true }: {
  content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision
  view: LoadoutView; onViewChange: (view: LoadoutView) => void; viewLabel: string
  primaryClassField: ReactNode; subCommandField: ReactNode; equipmentFields: ReactNode; passiveFields: ReactNode; passiveTools?: ReactNode
  selection?: DefinitionOption; comparedWith?: DefinitionOption; selectionActions?: ReactNode; showClassPermissions?: boolean
  notes?: ReactNode; context?: ReactNode; onCalculationChange?: (plan: BuildCalculationPlan | undefined) => void; onReviewGameSetup?: () => void
  recorded?: Readonly<Record<string, ObservedStat>>; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean; unknownPrimaryClass?: boolean
  showChecks?: boolean; showStats?: boolean
}) {
  const classSection = useRef<HTMLElement>(null)
  const equipmentSection = useRef<HTMLElement>(null)
  const passiveSection = useRef<HTMLElement>(null)
  const statsSection = useRef<HTMLDetailsElement>(null)
  const reveal = (section: HTMLElement | null) => {
    if (!section) return
    if (section instanceof HTMLDetailsElement) section.open = true
    section.scrollIntoView({ block: 'start' })
    section.focus({ preventScroll: true })
  }
  return <div className="stack loadout-sheet">
    {showChecks && <div className="build-sheet__view-switch"><Segmented label={viewLabel} onChange={onViewChange} options={[{ value: 'loadout', label: 'Loadout' }, { value: 'checks', label: 'Checks & notes' }]} value={view}/></div>}
    {view === 'loadout' ? <>
      <nav aria-label="Loadout sections" className="loadout-sections">
        <button aria-label="Jump to class and command" onClick={() => reveal(classSection.current)} type="button">Class</button>
        <button aria-label="Jump to equipment" onClick={() => reveal(equipmentSection.current)} type="button">Equipment</button>
        <button aria-label="Jump to passives" onClick={() => reveal(passiveSection.current)} type="button">Passives</button>
        {showStats && <button aria-label="Jump to stats" onClick={() => reveal(statsSection.current)} type="button">Stats</button>}
      </nav>
      <div className="build-sheet__layout">
        <div className="build-sheet__slots">
          <section aria-label="Class and command" className="build-sheet__group" ref={classSection} tabIndex={-1}><h3><Icon name="crystal"/>Class & command</h3>{primaryClassField}<PrimaryClassGrowth catalogs={catalogs} localData={localData} primaryClass={content.primaryClass}/>{subCommandField}</section>
          <section aria-label="Equipment" className="build-sheet__group" ref={equipmentSection} tabIndex={-1}><h3><Icon name="sword"/>Equipment</h3><div className="build-sheet__equipment">{equipmentFields}</div></section>
          <section aria-label="Passives" className="build-sheet__group" ref={passiveSection} tabIndex={-1}><h3><Icon name="spark"/>Equipped passives</h3>{passiveTools}<div className="build-sheet__passives">{passiveFields}</div></section>
        </div>
        <aside aria-label="Selection details" className="build-sheet__preview">
          <span className="eyebrow">Selection details</span>
          {selection && <h3 className="icon-label"><DefinitionArtwork catalogs={catalogs} localData={localData} value={selection.ref}/>{nativeDisplayName(selection.record)}</h3>}
          <LoadoutSelectionDetails catalogs={catalogs} comparedWith={comparedWith} gameSetup={gameSetup} localData={localData} option={selection} showClassPermissions={showClassPermissions} showIdentity={false}/>{selection && selectionActions}
        </aside>
      </div>
      {context}
      {showStats && <details className="loadout-stats" open ref={statsSection} tabIndex={-1}>
        <summary>Stats</summary>
        <div className="stack">
          <CalculatedStats gameSetup={gameSetup} catalogs={catalogs} content={content} localData={localData} onChange={onCalculationChange} onReviewGameSetup={onReviewGameSetup} recorded={recorded} slots={slots} unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass}/>
          <details className="loadout-stat-breakdown"><summary>Stat breakdown</summary><BuildStatsOverview gameSetup={gameSetup} catalogs={catalogs} content={content} localData={localData} onReviewGameSetup={onReviewGameSetup} slots={slots} unknownPrimaryClass={unknownPrimaryClass} unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass}/></details>
        </div>
      </details>}
    </> : <section aria-label="Build checks and notes" className="build-sheet__checks stack">
      {unknownInputs?.length ? <p className="field__hint">Equipment checks use recorded selections. Unknown slots cannot be checked.</p> : null}
      <BuildMechanics unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass} gameSetup={gameSetup} catalogs={catalogs} content={content} localData={localData} onChange={onCalculationChange} slots={slots}/>
      {notes}
    </section>}
  </div>
}
