import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { entityDefinitionKey, partitionQuery } from '../domain'
import type { CatalogSnapshot, EntityRef, InventoryEventKind, InventoryPosition, Knowledge, PossessionState, Profile, Quantity, QueryNode, QueryRecord, QueryValue } from '../domain/types'
import { Badge, BoundedFacetOptions, Button, EmptyState, Field, IconButton, InlineNotice, ScreenHeader } from './components'
import { Icon } from './icons'
import { entityName, formatRelativeDate, knowledgeLabel, ownRecordValue, quantityLabel } from './model'
import { INVENTORY_PAGE_SIZE, ROUTE_MAX_RESULT_LIMIT, commitInventoryRouteState, readInventoryRouteState, type InventoryRouteState } from './route-state'
import { buildFacetOptions, buildReferenceSearchItems } from './search'
import { Sheet } from './Sheet'
import { DefinitionPickerField, findDefinitionOption, useDefinitionWorkspace, type DefinitionOption } from './definitions'
import { useNavigation, type InventoryPageRoute } from './navigation'

export interface InventoryDraft {
  readonly name: string
  readonly ref?: EntityRef
  readonly possession: PossessionState
  readonly quantity: Quantity
  readonly favorite: boolean
  readonly protectedQuantity: number
  readonly wishlist: boolean
  readonly note?: string
  readonly observedAt?: string | null
}

export interface InventoryEventDraft {
  readonly name: string
  readonly ref?: EntityRef
  readonly kind: InventoryEventKind
  readonly quantity: Knowledge<number>
  readonly observedAt?: string
  readonly note?: string
}

const filters = ['All', 'Owned', 'Unknown', 'Wishlist', 'Protected'] as const

function toggleValue(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
}

function blankDraft(): InventoryDraft {
  return { name: '', possession: 'unknown', quantity: { kind: 'unknown' }, favorite: false, protectedQuantity: 0, wishlist: false }
}

function InventoryForm({ initial, onCancel, onSubmit, submitLabel }: { initial?: InventoryDraft; onCancel: () => void; onSubmit: (draft: InventoryDraft) => Promise<void> | void; submitLabel: string }) {
  const { options } = useDefinitionWorkspace()
  const [draft, setDraft] = useState(initial ?? blankDraft())
  const [quantityKind, setQuantityKind] = useState<Quantity['kind']>(draft.quantity.kind)
  const [quantityValue, setQuantityValue] = useState(draft.quantity.kind === 'unknown' ? 1 : draft.quantity.value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const selectPossession = (possession: PossessionState) => {
    setDraft({ ...draft, possession })
    if (possession === 'notOwned') { setQuantityKind('exact'); setQuantityValue(0) }
    if (possession === 'unknown') setQuantityKind('unknown')
    if (possession === 'owned' && (quantityKind === 'unknown' || quantityValue < 1)) { setQuantityKind('atLeast'); setQuantityValue(1) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit({ ...draft, quantity: quantityKind === 'unknown' ? { kind: 'unknown' } : { kind: quantityKind, value: Math.max(0, quantityValue) } })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The inventory observation could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  return <form className="stack" id="inventory-entry" onSubmit={submit}>
    <DefinitionPickerField allowedKinds={['item']} hint="Search an exact definition, create a personal item, or keep the reference unknown." label="Item definition" onChange={(ref) => { const selected = findDefinitionOption(options, ref); setDraft({ ...draft, ref: ref ?? undefined, name: selected?.name ?? draft.name }) }} routeKey="item-definition" value={draft.ref}/>
    <Field label="Item name" required><input autoComplete="off" autoFocus name="name" onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Enter the name shown in game" required value={draft.name}/></Field>
    <div className="grid-2"><Field label="Current possession"><select onChange={(event) => selectPossession(event.target.value as PossessionState)} value={draft.possession}><option value="unknown">Current possession unknown</option><option value="owned">Owned now</option><option value="notOwned">Not currently owned</option></select></Field><Field label="Quantity certainty"><select disabled={draft.possession === 'notOwned'} onChange={(event) => setQuantityKind(event.target.value as Quantity['kind'])} value={quantityKind}><option value="unknown">Unknown count</option><option value="atLeast">At least</option><option value="exact">Exact count</option></select></Field></div>
    {quantityKind !== 'unknown' && <Field hint="Total stock includes equipped copies." label={quantityKind === 'exact' ? 'Current count' : 'Known minimum'}><input inputMode="numeric" min="0" onChange={(event) => setQuantityValue(event.target.valueAsNumber || 0)} type="number" value={quantityValue}/></Field>}
    <div className="grid-2"><Field label="Protected copies"><input inputMode="numeric" min="0" onChange={(event) => setDraft({ ...draft, protectedQuantity: event.target.valueAsNumber || 0 })} type="number" value={draft.protectedQuantity}/></Field><Field hint={initial?.observedAt ? 'Clear this field to explicitly remove the saved observation date.' : undefined} label="Observed on"><input onChange={(event) => setDraft({ ...draft, observedAt: event.target.value || (initial?.observedAt ? null : undefined) })} type="date" value={draft.observedAt?.slice(0, 10) ?? ''}/></Field></div>
    <div className="grid-2"><label className="check-row"><input checked={draft.favorite} onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })} type="checkbox"/><span><strong>Favorite</strong><small>Keep this item easy to find</small></span></label><label className="check-row"><input checked={draft.wishlist} onChange={(event) => setDraft({ ...draft, wishlist: event.target.checked })} type="checkbox"/><span><strong>Wishlist</strong><small>A desired item, separate from possession</small></span></label></div>
    <Field label="Note"><textarea onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} placeholder="Optional observation or reminder" value={draft.note ?? ''}/></Field>
    <InlineNotice title={draft.ref?.kind === 'catalog' ? 'Catalog-linked observation' : 'Manual observation'}>{draft.ref?.kind === 'catalog' ? 'This records current inventory against the selected exact catalog definition.' : 'This creates a personal item definition and a separate inventory observation. You can link it to an imported reference later.'}</InlineNotice>{error && <InlineNotice title="Observation not saved" tone="danger">{error} Your entered values remain in this form.</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.name.trim()} icon="check" type="submit">{busy ? 'Saving...' : submitLabel}</Button></div>
  </form>
}

function positionDraft(profile: Profile, catalogs: readonly CatalogSnapshot[], position: InventoryPosition): InventoryDraft {
  return { name: position.observedName ?? entityName(profile, catalogs, position.ref), ref: position.ref, possession: position.possession, quantity: position.quantity, favorite: position.favorite, protectedQuantity: position.protectedQuantity, wishlist: position.wishlist, note: position.note, observedAt: position.observedAt }
}

function InventoryEventForm({ onCancel, onSubmit }: {
  readonly onCancel: () => void
  readonly onSubmit: (draft: InventoryEventDraft) => Promise<void>
}) {
  const { options } = useDefinitionWorkspace()
  const [draft, setDraft] = useState<InventoryEventDraft>({ name: '', kind: 'acquired', quantity: { state: 'unknown' } })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The inventory event could not be saved.') } finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit}>
    <DefinitionPickerField allowedKinds={['item']} autoFocus hint="Choose an exact item definition or create a personal entry." label="Item reference" onChange={(ref) => { const option = findDefinitionOption(options, ref); setDraft({ ...draft, ref: ref ?? undefined, name: option?.name ?? draft.name }) }} routeKey="event-item-reference" value={draft.ref}/>
    <Field label="Item display name" required><input onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Enter the observed item name" required value={draft.name}/></Field>
    <div className="grid-2"><Field label="Event"><select onChange={(event) => setDraft({ ...draft, kind: event.target.value as InventoryEventKind })} value={draft.kind}><option value="acquired">Acquired</option><option value="lost">Lost</option></select></Field><Field label="Amount certainty"><select onChange={(event) => setDraft({ ...draft, quantity: event.target.value === 'known' ? { state: 'known', value: 1 } : { state: 'unknown' } })} value={draft.quantity.state === 'known' ? 'known' : 'unknown'}><option value="unknown">Amount unknown</option><option value="known">Known amount</option></select></Field></div>
    {draft.quantity.state === 'known' && <Field hint="This amount is event history, not a current stock count." label="Amount"><input inputMode="numeric" min="1" onChange={(event) => setDraft({ ...draft, quantity: { state: 'known', value: event.target.valueAsNumber } })} required type="number" value={draft.quantity.value}/></Field>}
    <div className="grid-2"><Field label="Occurred on"><input onChange={(event) => setDraft({ ...draft, observedAt: event.target.value || undefined })} type="date" value={draft.observedAt ?? ''}/></Field><Field label="Event note"><input onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} placeholder="Optional historical context" value={draft.note ?? ''}/></Field></div>
    <InlineNotice title="History does not change stock">Saving an acquisition or loss records only the event. Record current possession separately after observing it.</InlineNotice>
    {error && <InlineNotice title="Event not saved" tone="danger">{error} Your entered values remain in this form.</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.name.trim()} icon="check" type="submit">{busy ? 'Saving...' : 'Save event'}</Button></div>
  </form>
}

export interface InventoryViewProps {
  readonly profile: Profile
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onAdd: (draft: InventoryDraft) => Promise<void>
  readonly onUpdate: (positionId: string, draft: InventoryDraft) => Promise<void>
  readonly onRecordEvent: (draft: InventoryEventDraft) => Promise<void>
  readonly onOpenData: () => void
}

function categoryFacetValues(option: DefinitionOption | undefined) {
  const strings = (value: unknown) => typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : []
  if (option?.category?.state === 'known') return strings(option.category.value)
  if (option?.category?.state === 'conflicting') return option.category.claims.flatMap((claim) => strings(claim.value))
  return []
}

function categoryQueryValue(option: DefinitionOption | undefined): QueryValue {
  const category = option?.category
  if (!category) return { state: 'unknown', reason: 'No linked definition category' }
  if (category.state === 'known') {
    const values = categoryFacetValues(option)
    return values.length > 0 ? { ...category, value: values } : { state: 'unknown', reason: 'The linked definition category is not text' }
  }
  if (category.state === 'conflicting') {
    const claims = category.claims.map((claim) => ({ ...claim, value: typeof claim.value === 'string' ? [claim.value] : Array.isArray(claim.value) ? claim.value.filter((entry): entry is string => typeof entry === 'string') : [] }))
    return claims.every((claim) => claim.value.length > 0) ? { state: 'conflicting', claims } : { state: 'unknown', reason: 'The linked definition category claims are not all text' }
  }
  return category
}

export function InventoryView({ profile, catalogs, onAdd, onUpdate, onRecordEvent, onOpenData }: InventoryViewProps) {
  const navigation = useNavigation()
  const { options } = useDefinitionWorkspace()
  const positions = Object.values(profile.inventory)
  const events = Object.values(profile.inventoryEvents).sort((left, right) => (right.observedAt ?? right.recordedAt).localeCompare(left.observedAt ?? left.recordedAt))
  const route = readInventoryRouteState()
  const [eventLimit, setEventLimit] = useState(100)
  const page = navigation.route.page.page === 'inventory' ? navigation.route.page : { page: 'inventory', view: 'list' } as const
  const adding = page.view === 'new'
  const recordingEvent = page.view === 'event-new'
  const editing = page.view === 'edit' ? ownRecordValue(profile.inventory, page.positionId) : undefined
  const missingPosition = page.view === 'edit' && !editing
  const navigate = (next: InventoryPageRoute) => navigation.navigate({ ...navigation.route, page: next, overlays: [] })
  const referenceItems = useMemo(() => buildReferenceSearchItems(catalogs), [catalogs])
  const referenceByDefinition = useMemo(() => new Map(referenceItems.map((item) => [entityDefinitionKey({ kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id }), item])), [referenceItems])
  const optionByDefinition = useMemo(() => new Map(options.map((option) => [option.key, option])), [options])
  const linkedReferenceItems = useMemo(() => {
    const linked = new Map<string, (typeof referenceItems)[number]>()
    for (const position of positions) {
      const item = referenceByDefinition.get(entityDefinitionKey(position.ref))
      if (item) linked.set(item.key, item)
    }
    return [...linked.values()]
  }, [positions, referenceByDefinition, referenceItems])
  const categoryOptions = useMemo(() => {
    const counts = new Map(buildFacetOptions(linkedReferenceItems, 'category').map((option) => [option.value, option.count]))
    for (const position of positions) {
      if (position.ref.kind !== 'personal') continue
      for (const value of new Set(categoryFacetValues(optionByDefinition.get(entityDefinitionKey(position.ref))))) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value))
  }, [linkedReferenceItems, optionByDefinition, positions])
  const sourceOptions = useMemo(() => {
    const imported = buildFacetOptions(linkedReferenceItems, 'source')
    const personalCount = positions.filter((position) => position.ref.kind === 'personal').length
    return personalCount ? [{ value: 'Personal entry', count: personalCount }, ...imported] : imported
  }, [linkedReferenceItems, positions])
  const updateRoute = useCallback((change: Partial<InventoryRouteState>, mode: 'push' | 'replace' = 'replace') => {
    commitInventoryRouteState({ ...route, ...change }, mode)
  }, [route])
  const updateFilter = useCallback((change: Partial<InventoryRouteState>, mode: 'push' | 'replace' = 'replace') => updateRoute({ ...change, resultLimit: INVENTORY_PAGE_SIZE }, mode), [updateRoute])
  const partition = useMemo(() => {
    const children: QueryNode[] = []
    for (const token of route.query.trim().split(/\s+/).filter(Boolean)) children.push({ kind: 'predicate', field: 'text', operator: 'contains', value: token })
    if (route.filter === 'Owned') children.push({ kind: 'predicate', field: 'possession', operator: 'eq', value: 'owned' })
    if (route.filter === 'Unknown') children.push({ kind: 'or', children: [{ kind: 'predicate', field: 'possession', operator: 'eq', value: 'unknown' }, { kind: 'predicate', field: 'quantityKind', operator: 'eq', value: 'unknown' }] })
    if (route.filter === 'Wishlist') children.push({ kind: 'predicate', field: 'wishlist', operator: 'eq', value: true })
    if (route.filter === 'Protected') children.push({ kind: 'predicate', field: 'protectedQuantity', operator: 'gt', value: 0 })
    if (route.categories.length) children.push({ kind: 'or', children: route.categories.map((value) => ({ kind: 'predicate', field: 'category', operator: 'eq', value })) })
    if (route.sources.length) children.push({ kind: 'or', children: route.sources.map((value) => ({ kind: 'predicate', field: 'source', operator: 'eq', value })) })
    const tree: QueryNode = { kind: 'and', children }
    return partitionQuery(positions, tree, (position): QueryRecord => {
      const reference = referenceByDefinition.get(entityDefinitionKey(position.ref))
      const personalDefinition = position.ref.kind === 'personal' ? optionByDefinition.get(entityDefinitionKey(position.ref)) : undefined
      const name = position.observedName ?? entityName(profile, catalogs, position.ref)
      const referenceText = reference ? `${reference.entity.name} ${reference.entity.aliases.join(' ')} ${reference.entity.rawDescription ?? ''}` : personalDefinition ? `${personalDefinition.name} ${personalDefinition.aliases.join(' ')} ${personalDefinition.description ?? ''} ${categoryFacetValues(personalDefinition).join(' ')}` : ''
      return {
        text: { state: 'known', value: `${name} ${referenceText}` },
        possession: { state: 'known', value: position.possession },
        quantityKind: { state: 'known', value: position.quantity.kind },
        wishlist: { state: 'known', value: position.wishlist },
        protectedQuantity: { state: 'known', value: position.protectedQuantity },
        category: reference?.projection.category ?? categoryQueryValue(personalDefinition),
        source: position.ref.kind === 'personal' ? { state: 'known', value: ['Personal entry'] } : reference?.projection.source ?? { state: 'unknown', reason: 'No linked catalog source' },
      }
    })
  }, [catalogs, optionByDefinition, positions, profile, referenceByDefinition, route])
  const visible = [...partition.confirmed, ...partition.possible]

  const add = async (draft: InventoryDraft) => {
    await onAdd(draft)
    navigation.close()
  }
  const update = async (draft: InventoryDraft) => {
    if (!editing) return
    await onUpdate(editing.id, draft)
    navigation.close()
  }
  const recordEvent = async (draft: InventoryEventDraft) => { await onRecordEvent(draft); navigation.close() }

  return <>
    <ScreenHeader actions={<><Button icon="plus" onClick={() => navigate({ page: 'inventory', view: 'new' })}>Add item</Button><Button onClick={() => navigate({ page: 'inventory', view: 'event-new' })} tone="secondary">Record event</Button><Button icon="upload" onClick={onOpenData} tone="secondary">Import</Button></>} description="Keep track of your equipment, consumables, and the copies available to your party." eyebrow="Items & equipment" title="Inventory"/>
    {missingPosition && <InlineNotice title="Inventory entry unavailable" tone="warning">The requested inventory entry is not part of the active playthrough. It may have been removed or the link may belong to another profile. <Button onClick={() => navigate({ page: 'inventory', view: 'list' })} tone="quiet">Return to inventory</Button></InlineNotice>}
    {positions.length === 0 ? <EmptyState className="empty-state--inventory" aside={<><strong>Not sure how many you own?</strong>Leave the quantity unknown. Looking up an item in Reference never adds it to your inventory.</>} description="Found a new weapon, a piece of armor, or a useful consumable? Record it here to keep track of what your party can use." icon="chest" title="Record your first item"><Button icon="plus" onClick={() => navigate({ page: 'inventory', view: 'new' })}>Add an item</Button><Button icon="upload" onClick={onOpenData} tone="secondary">Import a record</Button></EmptyState> : <div className="panel">
      <div className="panel__header toolbar"><div className="search-field"><Icon name="search"/><input aria-label="Search inventory" onChange={(event) => updateFilter({ query: event.target.value })} placeholder="Search names and linked descriptions" type="search" value={route.query}/></div><div className="cluster"><Badge tone={visible.some((item) => item.quantity.kind === 'unknown') ? 'warning' : 'neutral'}>{partition.confirmed.length} confirmed</Badge>{partition.possible.length > 0 && <Badge tone="warning">{partition.possible.length} possible</Badge>}</div></div>
      <div className="panel__body inventory-facets"><div><h3>Inventory state</h3><div aria-label="Inventory filters" className="filter-chips" role="group">{filters.map((value) => <button aria-pressed={route.filter === value} className="filter-chip" key={value} onClick={() => updateFilter({ filter: value }, 'push')} type="button">{value}</button>)}</div></div>{categoryOptions.length > 0 && <div><h3>Linked category</h3><BoundedFacetOptions groupLabel="Inventory category filters" onClear={() => updateFilter({ categories: [] }, 'push')} onToggle={(value) => updateFilter({ categories: toggleValue(route.categories, value) }, 'push')} options={categoryOptions} searchLabel="Search inventory categories" selected={route.categories}/></div>}{sourceOptions.length > 0 && <div><h3>Linked source</h3><BoundedFacetOptions groupLabel="Inventory source filters" onClear={() => updateFilter({ sources: [] }, 'push')} onToggle={(value) => updateFilter({ sources: toggleValue(route.sources, value) }, 'push')} options={sourceOptions} searchLabel="Search inventory sources" selected={route.sources}/></div>}</div>
      {visible.length ? <><ul aria-live="polite" className="list">{visible.slice(0, route.resultLimit).map((position) => {
        const name = position.observedName ?? entityName(profile, catalogs, position.ref)
        const tone = position.possession === 'owned' ? 'positive' : position.possession === 'notOwned' ? 'neutral' : 'warning'
        return <li className="list-row" key={position.id}><div className="list-row__primary"><strong>{name}</strong><small>{position.ref.kind === 'personal' ? 'Personal entry' : 'Catalog-linked item'} · {formatRelativeDate(position.observedAt)}</small></div><div><Badge tone={tone}>{position.possession === 'owned' ? 'Owned' : position.possession === 'notOwned' ? 'Not owned' : 'Possession unknown'}</Badge></div><div className="list-row__fact"><strong>{quantityLabel(position.quantity)}</strong><small>{position.protectedQuantity ? `${position.protectedQuantity} protected` : position.wishlist ? 'On wishlist' : 'No special policy'}</small></div><div className="list-row__action"><IconButton icon="edit" label={`Edit ${name}`} onClick={() => navigate({ page: 'inventory', view: 'edit', positionId: position.id })}/></div></li>
      })}</ul>{visible.length > route.resultLimit && route.resultLimit < ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><Button onClick={() => updateRoute({ resultLimit: Math.min(ROUTE_MAX_RESULT_LIMIT, route.resultLimit + INVENTORY_PAGE_SIZE) })} tone="secondary">Show {Math.min(INVENTORY_PAGE_SIZE, visible.length - route.resultLimit)} more</Button></div>}{visible.length > ROUTE_MAX_RESULT_LIMIT && route.resultLimit >= ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><InlineNotice title="Inventory display limit reached">Refine the name, category, source, or inventory-state filters to reach entries beyond the first {ROUTE_MAX_RESULT_LIMIT.toLocaleString()} matches.</InlineNotice></div>}</> : <div className="panel__body"><InlineNotice title="No matching entries">Change the search or filters to see another part of your recorded inventory. Unknown catalog facets remain possible matches.</InlineNotice></div>}
    </div>}
    <section className="panel" style={{ marginTop: 18 }}><div className="panel__header"><div><h2>Acquisition & loss history</h2><p>Historical events stay separate from current stock</p></div><Button onClick={() => navigate({ page: 'inventory', view: 'event-new' })} tone="secondary">Record event</Button></div>{events.length ? <><ul className="list">{events.slice(0, eventLimit).map((entry) => <li className="list-row" key={entry.id}><div className="list-row__primary"><strong>{entry.observedName ?? entityName(profile, catalogs, entry.ref)}</strong><small>{formatRelativeDate(entry.observedAt)} · Recorded {formatRelativeDate(entry.recordedAt)}</small></div><Badge tone={entry.kind === 'acquired' ? 'positive' : 'warning'}>{entry.kind === 'acquired' ? 'Acquired' : 'Lost'}</Badge><div className="list-row__fact"><strong>{knowledgeLabel(entry.quantity, (value) => `${value}`)}</strong><small>{entry.quantity.state === 'known' ? 'Recorded amount' : 'Amount unknown'}</small></div><div className="list-row__fact">{entry.note ?? 'No event note'}</div></li>)}</ul>{events.length > eventLimit && <div className="panel__body"><Button onClick={() => setEventLimit((value) => value + 100)} tone="secondary">Show 100 more events</Button></div>}</> : <div className="panel__body"><InlineNotice title="No acquisition or loss events">Add historical events here without changing the current inventory observation.</InlineNotice></div>}</section>
    <Sheet description="Record current possession and quantity without implying anything from earlier acquisitions." onClose={() => navigation.close()} open={adding} title="Add inventory item"><InventoryForm onCancel={() => navigation.close()} onSubmit={add} submitLabel="Add item"/></Sheet>
    <Sheet description="This records a corrected current observation. It does not create a gain or loss event." onClose={() => navigation.close()} open={Boolean(editing)} title="Edit inventory observation">{editing && <InventoryForm initial={positionDraft(profile, catalogs, editing)} key={editing.id} onCancel={() => navigation.close()} onSubmit={update} submitLabel="Save observation"/>}</Sheet>
    <Sheet description="Record a historical event without adjusting current stock." onClose={() => navigation.close()} open={recordingEvent} title="Record acquisition or loss"><InventoryEventForm onCancel={() => navigation.close()} onSubmit={recordEvent}/></Sheet>
  </>
}
