import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SUMMONS, type Summon, type SummonId } from '../catalog/summons'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import { historicalCatalogKeys } from '../domain/corrections'
import { logicalEntityKey, preferredDefinitionRef } from '../domain/definitions'
import { entityDefinitionKey, requirePlaythrough } from '../domain/core'
import { summonUnlockState } from '../domain/summons'
import type { CatalogEntity, CatalogSnapshot, EntityId, EntityRef, LocalData, ProgressRecordId } from '../domain/types'
import { Button, InlineNotice } from './components'
import { Icon } from './icons'
import { ProgressPage } from './ProgressPage'
import { ReferenceLink } from './ReferenceLink'
import { CatalogArtwork } from './WikiSprite'
import { useQueuedTileUpdates } from './useQueuedTileUpdates'
import './summons.css'

export function summonEntries(localData: LocalData, catalogs: readonly CatalogSnapshot[]) {
  const historical = historicalCatalogKeys(catalogs)
  const catalog = catalogs.find(catalog => catalog.id === STARTER_CATALOG_ID && !historical.has(JSON.stringify([catalog.id, catalog.revisionId])))
  if (!catalog) return []
  const records = new Map(Object.values(requirePlaythrough(localData).progress).map(record => [logicalEntityKey(localData, record.subject), record]))
  return SUMMONS.flatMap(summon => {
    const entity = catalog.entities[summon.id]
    if (entity?.kind !== 'ability') return []
    const subject = preferredDefinitionRef(localData, { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: summon.id as EntityId })
    const key = logicalEntityKey(localData, subject)
    const record = records.get(key)
    const artwork = catalog.entities[summon.monsterId]
    const deityRef = artwork?.kind === 'monster' ? preferredDefinitionRef(localData, { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: summon.monsterId }) : undefined
    return [{ summon, subject, deityRef, key, record, artwork, state: summonUnlockState(summon, record) }]
  })
}

const SummonTile = memo(function SummonTile({ summon, artwork, skillRef, deityRef, unlocked, uncertain, pending, focused, onToggle }: {
  readonly summon: Summon
  readonly artwork?: CatalogEntity
  readonly skillRef: EntityRef
  readonly deityRef?: EntityRef
  readonly unlocked: boolean
  readonly uncertain: boolean
  readonly pending: boolean
  readonly focused: boolean
  readonly onToggle: (id: SummonId, unlocked: boolean) => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (focused) buttonRef.current?.focus() }, [focused])
  return <li className="summon-tile" data-focused={focused || undefined} data-summon={summon.id} data-unlocked={unlocked} style={{ gridColumn: summon.column + 1, gridRow: summon.row + 1 }}>
    <button aria-busy={pending || undefined} aria-label={`${summon.label}: ${summon.starting ? 'Always unlocked' : unlocked ? 'Mark not unlocked' : 'Mark unlocked'}`} aria-pressed={unlocked} className="summon-tile__toggle" disabled={summon.starting} onClick={() => onToggle(summon.id, unlocked)} ref={buttonRef} type="button">
      <span className="summon-tile__status">{uncertain ? 'Needs confirmation' : unlocked ? 'Unlocked' : 'Not unlocked'}<span aria-hidden="true">{unlocked && <Icon name="check"/>}</span></span>
      <span aria-hidden="true" className="summon-tile__art">{artwork ? <CatalogArtwork catalogId={STARTER_CATALOG_ID} entity={artwork}/> : <Icon name="spark"/>}</span>
      <strong>{summon.name},<span> Deity of {summon.title}</span></strong>
      <small>{summon.starting ? 'Starting summon' : unlocked ? 'Click to undo' : 'Click to unlock'}</small>
    </button>
    <div className="summon-tile__links">
      <ReferenceLink refValue={skillRef}><span className="sr-only">{summon.name}: </span>Skill</ReferenceLink>
      {deityRef && <ReferenceLink refValue={deityRef}><span className="sr-only">{summon.name}: </span>Deity</ReferenceLink>}
    </div>
  </li>
}, (previous, next) => previous.summon === next.summon
  && previous.artwork === next.artwork
  && previous.unlocked === next.unlocked
  && previous.uncertain === next.uncertain
  && previous.pending === next.pending
  && previous.focused === next.focused
  && previous.onToggle === next.onToggle
  && entityDefinitionKey(previous.skillRef) === entityDefinitionKey(next.skillRef)
  && (previous.deityRef ? entityDefinitionKey(previous.deityRef) : undefined) === (next.deityRef ? entityDefinitionKey(next.deityRef) : undefined))

export interface SummonsViewProps {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onToggle: (id: SummonId) => Promise<void>
  readonly focusedRecordId?: ProgressRecordId
}

export function SummonsView({ localData, catalogs, onToggle, focusedRecordId }: SummonsViewProps) {
  const entries = useMemo(() => summonEntries(localData, catalogs), [localData, catalogs])
  const { queuedUpdates, enqueue } = useQueuedTileUpdates<SummonId, boolean>()
  const [failure, setFailure] = useState<{ readonly id: SummonId; readonly message: string }>()
  const toggle = useCallback((id: SummonId, unlocked: boolean) => {
    setFailure(undefined)
    enqueue(id, unlocked, state => !state, () => onToggle(id), reason => {
      setFailure(current => current ?? { id, message: reason instanceof Error ? reason.message : 'The summon unlock could not be saved.' })
    })
  }, [enqueue, onToggle])
  const displayed = entries.map(entry => ({ ...entry, unlocked: queuedUpdates.get(entry.summon.id)?.state ?? (entry.state.state === 'known' && entry.state.value), uncertain: !queuedUpdates.has(entry.summon.id) && entry.state.state !== 'known' }))
  const unlockedCount = displayed.filter(entry => entry.unlocked).length
  const uncertainCount = displayed.filter(entry => entry.uncertain).length
  const failedEntry = displayed.find(entry => entry.summon.id === failure?.id)
  return <ProgressPage count={unlockedCount} notices={failure && <InlineNotice title="Summon not saved" tone="danger">{failure.message} After queued clicks finish, the tile shows its saved state. <Button disabled={queuedUpdates.has(failure.id)} onClick={() => toggle(failure.id, failedEntry?.unlocked ?? false)} tone="secondary">Retry summon</Button></InlineNotice>} summaryNote={uncertainCount ? `${uncertainCount} imported observations need confirmation` : undefined} total={SUMMONS.length} variant="summons">
    {entries.length !== SUMMONS.length && <InlineNotice title="Summon references unavailable" tone="warning">Restore the bundled catalog to record every summon.</InlineNotice>}
    <section aria-label="Summoner skill tree" className="summons-board">
      <div className="summons-board__heading"><h2>Summons</h2><p>Click a gray tile to mark it unlocked. Click a gold tile to undo. Pinga stays unlocked.</p></div>
      <ol aria-label="Summons" className="summons-tree">{displayed.map(entry => <SummonTile artwork={entry.artwork} deityRef={entry.deityRef} focused={focusedRecordId !== undefined && entry.record?.id === focusedRecordId} key={entry.summon.id} onToggle={toggle} pending={queuedUpdates.has(entry.summon.id)} skillRef={entry.subject} summon={entry.summon} uncertain={entry.uncertain} unlocked={entry.unlocked}/>)}</ol>
    </section>
    <p className="summons-footnote">Pinga is the starting summon and is always unlocked. For the others, defeat the deity with a Summoner in your party to unlock its skill. Mark availability for this Playthrough; the other tiles start gray until you mark them. Character learning is recorded separately.</p>
  </ProgressPage>
}
