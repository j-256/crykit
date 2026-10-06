import { useEffect, useMemo, useRef, useState } from 'react'
import { STARTER_CATALOG_ID } from '../catalog/catalog-ids'
import { preferredStarterCatalog } from '../catalog/bundled'
import { TRAVEL_UNLOCK_GROUPS } from '../catalog/travel-unlock-groups'
import { catalogEntity } from '../domain/entity-identities'
import { acquisitionState, logicalEntityKey, preferredDefinitionRef, requirePlaythrough } from '../domain'
import type { CatalogEntity, CatalogSnapshot, EntityRef, Knowledge, LocalData, PartyProgressRecord, ProgressRecordId } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { ArtworkPlaceholder, CatalogArtwork } from './WikiSprite'
import { resolveEntity } from './model'
import { useNavigation, type AppRoute } from './navigation'
import { ProgressPage } from './ProgressPage'
import { useQueuedTileUpdates } from './useQueuedTileUpdates'

const ACQUISITION_FILTER = Object.freeze({ all: 'all', notAcquired: 'notAcquired', acquired: 'acquired' } as const)
type AcquisitionFilter = typeof ACQUISITION_FILTER[keyof typeof ACQUISITION_FILTER]

interface TravelUnlockEntry {
  readonly key: string
  readonly groupId: string
  readonly subject: EntityRef
  readonly name: string
  readonly artworkEntity?: CatalogEntity
  readonly record?: PartyProgressRecord
  readonly state: Knowledge<boolean>
}

export function travelUnlockEntries(localData: LocalData, catalogs: readonly CatalogSnapshot[]): readonly TravelUnlockEntry[] {
  const catalog = preferredStarterCatalog(catalogs)
  if (!catalog) return []
  const records = new Map(Object.values(requirePlaythrough(localData).progress).map(record => [logicalEntityKey(localData, record.subject), record]))
  return TRAVEL_UNLOCK_GROUPS.flatMap(group => group.entityIds.flatMap(entityId => {
    const entity = catalogEntity(catalog, entityId)
    if (entity?.kind !== 'item') return []
    const subject = preferredDefinitionRef(localData, { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id })
    const key = logicalEntityKey(localData, subject)
    const record = records.get(key)
    const definition = resolveEntity(localData, catalogs, subject)
    const artworkEntity = subject.kind === 'catalog' ? definition as CatalogEntity | undefined : undefined
    return [{ key, groupId: group.id, subject, name: definition?.name ?? entity.name, artworkEntity, record, state: acquisitionState(record) }]
  }))
}

export interface TravelUnlocksViewProps {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly saveBlocked: boolean
  readonly focusedRecordId?: ProgressRecordId
  readonly onSetAcquired: (subject: EntityRef, displayName: string, acquired: boolean) => Promise<void>
}

export function TravelUnlocksView({ localData, catalogs, saveBlocked, focusedRecordId, onSetAcquired }: TravelUnlocksViewProps) {
  const navigation = useNavigation()
  const entries = useMemo(() => travelUnlockEntries(localData, catalogs), [localData, catalogs])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AcquisitionFilter>(ACQUISITION_FILTER.all)
  const { queuedUpdates: queuedAcquisitions, enqueue: enqueueAcquisition } = useQueuedTileUpdates<string, Knowledge<boolean>>()
  const [error, setError] = useState<string>()
  const focusedInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!saveBlocked) setError(undefined)
  }, [saveBlocked])
  useEffect(() => {
    if (focusedRecordId) focusedInput.current?.focus()
  }, [focusedRecordId])
  const displayedEntries = entries.map(entry => {
    const queued = queuedAcquisitions.get(entry.key)
    return queued ? { ...entry, state: queued.state } : entry
  })
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim()
  const acquiredCount = displayedEntries.filter(entry => entry.state.state === 'known' && entry.state.value).length
  const unconfirmedCount = displayedEntries.filter(entry => entry.state.state !== 'known').length
  const visible = displayedEntries.filter(entry => entry.name.toLocaleLowerCase().includes(normalizedQuery)
    && (filter === ACQUISITION_FILTER.all || (entry.state.state === 'known' && entry.state.value === (filter === ACQUISITION_FILTER.acquired)) || entry.state.state !== 'known' && filter === ACQUISITION_FILTER.notAcquired))
  const setAcquired = (entry: TravelUnlockEntry, acquired: boolean) => {
    setError(undefined)
    enqueueAcquisition(entry.key, entry.state, () => ({ state: 'known', value: acquired }), () => onSetAcquired(entry.subject, entry.name, acquired), reason => {
      setError(reason instanceof Error ? reason.message : `The ${entry.name} acquisition could not be saved.`)
    })
  }
  const referenceLink = (entry: TravelUnlockEntry) => {
    const route: AppRoute = { page: { page: 'reference', view: 'detail', ref: entry.subject }, overlays: [], query: {} }
    return <a aria-label={`${entry.name}: location & requirements`} href={navigation.href(route)} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigation.navigate(route)
    }}>Location & requirements</a>
  }
  return <ProgressPage count={acquiredCount} summaryNote={unconfirmedCount > 0 ? `${unconfirmedCount} imported observations need confirmation` : undefined} total={entries.length} variant="unlocks">
    <div className="unlock-toolbar"><Field label="Find an unlock"><input onChange={event => setQuery(event.target.value)} placeholder="Instrument, stone, or capability item" type="search" value={query}/></Field><Field label="Acquisition filter"><select onChange={event => setFilter(event.target.value as AcquisitionFilter)} value={filter}><option value={ACQUISITION_FILTER.all}>All items</option><option value={ACQUISITION_FILTER.notAcquired}>Not acquired / needs confirmation</option><option value={ACQUISITION_FILTER.acquired}>Acquired</option></select></Field></div>
    {error && <InlineNotice title="Acquisition not saved" tone="danger">{error}</InlineNotice>}
    {!entries.length && <InlineNotice title="Travel references unavailable" tone="warning">Restore the bundled catalog to record this checklist.</InlineNotice>}
    {entries.length > 0 && visible.length === 0 && <InlineNotice title="No matching unlocks">Clear the search or change the acquisition filter to see more items.</InlineNotice>}
    {TRAVEL_UNLOCK_GROUPS.map(group => {
      const groupEntries = displayedEntries.filter(entry => entry.groupId === group.id)
      const visibleEntries = visible.filter(entry => entry.groupId === group.id)
      if (!visibleEntries.length) return null
      const count = groupEntries.filter(entry => entry.state.state === 'known' && entry.state.value).length
      return <section aria-label={group.label} className="unlock-group" key={group.id}>
        <header className="unlock-group__header"><div><h2>{group.label}</h2><p>{group.description}</p></div><span>{count} / {groupEntries.length} acquired</span></header>
        <div className="unlock-grid">{visibleEntries.map(entry => {
          const acquired = entry.state.state === 'known' && entry.state.value
          const uncertain = entry.state.state !== 'known'
          const focused = focusedRecordId !== undefined && entry.record?.id === focusedRecordId
          const busy = queuedAcquisitions.has(entry.key)
          return <article aria-busy={busy || undefined} className="unlock-tile" data-acquired={acquired} data-focused={focused || undefined} key={entry.key}>
            <label className="unlock-tile__toggle"><input aria-label={`${entry.name}: acquired`} aria-checked={uncertain ? 'mixed' : acquired} checked={acquired} disabled={saveBlocked} onChange={event => setAcquired(entry, event.target.checked)} ref={node => { if (node) node.indeterminate = uncertain; if (focused) focusedInput.current = node }} type="checkbox"/><span className="unlock-tile__artwork">{entry.artworkEntity ? <CatalogArtwork catalogId={STARTER_CATALOG_ID} entity={entry.artworkEntity}/> : <ArtworkPlaceholder entity={{ kind: 'item', name: entry.name }}/>}</span><span className="unlock-tile__text"><strong>{entry.name}</strong><small>{uncertain ? 'Acquisition needs confirmation' : acquired ? 'Acquired' : 'Not acquired'}</small></span></label>
            {uncertain && <div className="unlock-tile__uncertainty"><p>{entry.state.state === 'conflicting' ? 'Imported acquisition claims conflict.' : entry.state.state === 'notApplicable' ? 'Imported acquisition was marked not applicable.' : 'Imported acquisition is unknown.'} Choose acquired or not acquired to confirm this observation.</p><Button disabled={saveBlocked} onClick={() => setAcquired(entry, false)} tone="quiet">Mark not acquired</Button></div>}
            <div className="unlock-tile__links">{referenceLink(entry)}</div>
          </article>
        })}</div>
      </section>
    })}
    <p className="unlock-footnote">Unchecked items count as not acquired here. Inventory and character learning are tracked separately.</p>
  </ProgressPage>
}
