import { MoneyText } from './MoneyText'
import { activeCorrections, CORRECTION_DECISIONS, correctionKey, correctionSource, correctionStatus } from '../domain/corrections'
import { useCorrections } from './corrections-context'
import { CorrectionsButton } from './Corrections'
import { EditableReference, type EditableReferencePath } from './InlineCorrection'
import { CorrectionDiff } from './CorrectionEditor'
import { DefinitionClaimsPanel, DefinitionFactsPanel, DefinitionPlanningPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { reviewedCatalogDecisions } from '../interchange/correction-promotion'
import { modState } from '../domain/mods'
import { normalizeWeaponType, skillWeaponLabel, skillWeaponRule, UNRESTRICTED_WEAPON_SKILLS_MOD, WEAPON_TYPES } from '../domain/skill-weapons'
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { definitionLineageRootRef, entityDefinitionKey, preferredDefinitionRef } from '../domain'
import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, CatalogRef, EntityRef, LocalData, GameSetupRevisionId } from '../domain/types'
import { Badge, BoundedFacetOptions, Button, EmptyState, InlineNotice, ScreenHeader } from './components'
import { Icon } from './icons'
import { formatAppError, knowledgeTone } from './model'
import { DefinitionEditor, findDefinitionOption, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { ModBadge } from './DefinitionModLabel'
import { routeWithOverlay, useNavigation, type ReferencePageRoute } from './navigation'
import { Sheet } from './Sheet'
import { KnowledgeValue } from './KnowledgeValue'
import { ArtworkPlaceholder, CatalogArtwork, CatalogArtworkSource } from './WikiSprite'
import { FieldIconSources } from './GameIcon'
import { sourceDisplay, visibleDefinitionFacts } from './source-display'
import { ClassResearch } from './ClassResearch'
import { nativeDefinitionLabel, nativeDisplayDescription, nativeDisplayName, nativeRecord, nativeSourceRecord, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import { NativeClassSourceDetails, NativeDefinitionDetails } from './NativeDefinitionDetails'
import { isNativeEnemy, NativeEnemyHero, NativeEnemyStats } from './NativeEnemyDetails'
import { Dropdown } from './Dropdown'
import { NavigationLink } from './NavigationLink'
import { routeForSearchTarget } from './search-navigation'
import { ReferenceCategoryFilters, ReferenceFacetSection } from './ReferenceFacets'
import { DEFINITION_KIND_GROUPS, DEFINITION_KIND_LABELS, OPTIONAL_REFERENCE_AUDIENCES, referenceCategoryGroup, referenceFieldFacets, REFERENCE_FACETS, type OptionalReferenceAudience, type ReferenceFacetKey } from './reference-facets'
import {
  projectReferenceEntity,
  aggregateKnowledgeCounts,
  buildFacetOptions,
  buildReferenceSearchItems,
  partitionPersonalDefinitionOptions,
  partitionReferenceItems,
  personalDefinitionCategoryValues,
  personalDefinitionFacetValues,
  type FacetOption,
  type ReferenceFilters,
  type ReferenceSearchItem,
} from './search'
import {
  commitReferenceRouteState,
  DEFAULT_REFERENCE_ROUTE_STATE,
  readReferenceRouteState,
  REFERENCE_PAGE_SIZE,
  ROUTE_MAX_RESULT_LIMIT,
  type ReferenceRouteState,
} from './route-state'

function referenceDefinitionKey(item: ReferenceSearchItem): string {
  return entityDefinitionKey({ kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id })
}

function SkillSummary({ entity }: { entity: Pick<CatalogEntity, 'kind' | 'fields'> }) {
  const className = entity.fields.Class ?? { state: 'unknown' as const }
  const cost = entity.fields.Cost ?? { state: 'unknown' as const }
  return <div className="skill-summary"><span><strong>Class:</strong> <KnowledgeValue compact value={className}/></span><span><strong>Weapons:</strong> {skillWeaponLabel(skillWeaponRule(entity))}</span><span><strong>Cost:</strong> <KnowledgeValue compact value={cost}/></span></div>
}

function toggleValue(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
}

function numericInput(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function ppLabel(item: ReferenceSearchItem): string {
  if (item.ppCost.state === 'known') return `${item.ppCost.value} PP`
  if (item.ppCost.state === 'conflicting') return 'PP conflict'
  if (item.ppCost.state === 'unknown') return 'PP unknown'
  return 'PP n/a'
}

function ReferenceActions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const focus = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  return <div className="reference-actions"><button aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="dialog" className="button button--quiet" onClick={() => setOpen(value => !value)} ref={anchor} type="button"><Icon name="more"/>Actions</button><Dropdown anchorRef={anchor} id={id} initialFocusRef={focus} onClose={close} onDismiss={close} open={open} title="Reference actions"><div className="reference-actions__content" ref={focus} tabIndex={-1} onClick={event => { if ((event.target as HTMLElement).closest('button')) close() }}>{children}</div></Dropdown></div>
}

function DetailView({ item: displayedItem, modAvailability, onBack, onEdit, personalOverride, onOpenDefinition, collectionAction }: { item: ReferenceSearchItem; modAvailability?: DefinitionOption['modAvailability']; onBack: () => void; onEdit: () => void; personalOverride?: DefinitionOption; onOpenDefinition: (ref: EntityRef) => void; collectionAction: ReactNode }) {
  const { baseline, collection } = useCorrections()
  const navigation = useNavigation()
  const [editing, setEditing] = useState(false)
  const [activeEdit, setActiveEdit] = useState<EditableReferencePath>()
  const [showOriginal, setShowOriginal] = useState(false)
  const [newFact, setNewFact] = useState('')
  const [extraFact, setExtraFact] = useState<string>()
  const target: CatalogRef = { kind: 'catalog', catalogId: displayedItem.catalog.id, catalogRevisionId: displayedItem.catalog.revisionId, entityId: displayedItem.entity.id }
  const original = correctionSource(baseline, target)
  const correction = activeCorrections(collection.entries).find(entry => correctionKey(entry) === correctionKey({ target }) && correctionStatus(entry, baseline, collection.entries) === 'applied')
  const pendingCorrection = activeCorrections(collection.entries).some(entry => correctionKey(entry) === correctionKey({ target }) && ['review', 'competing'].includes(correctionStatus(entry, baseline, collection.entries)))
  const reviewed = useMemo(() => activeCorrections(reviewedCatalogDecisions(displayedItem.catalog)).filter(entry => entry.changes.length && entry.target.entityId === displayedItem.entity.id), [displayedItem.catalog, displayedItem.entity.id])
  const item = showOriginal && original ? projectReferenceEntity(original.catalog, original.entity) : displayedItem
  const editable = (path: EditableReferencePath, label: string) => ({ target, path, label, editing: editing && !showOriginal, active: activeEdit === path, onActivate: () => { if (!activeEdit) setActiveEdit(path) }, onClose: () => setActiveEdit(undefined) })
  const nativeLabel = nativeDefinitionLabel(item.entity)
  const enemy = isNativeEnemy(item.entity)
  const classDefinition = item.entity.kind === 'class'
  const record = nativeSourceRecord(item.entity)
  const supplemental = nativeRecord(item.entity.legacy) && item.entity.legacy.supplemental === true
  const primarySourceId = nativeLabel ? item.entity.sources.find(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX))?.sourceId : undefined
  const facts = [...visibleDefinitionFacts(item.entity, editing)]
  if (extraFact && !Object.hasOwn(item.entity.fields, extraFact)) facts.push([extraFact, { state: 'unknown' }])
  const actions = <><CorrectionsButton/><Button disabled={Boolean(activeEdit)} icon="edit" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'correction-editor', ref: target }))} tone="secondary">Correct shared reference</Button><Button aria-pressed={editing} disabled={Boolean(activeEdit) || showOriginal} icon={editing ? "check" : "edit"} onClick={() => setEditing(value => !value)} tone={editing ? "primary" : "secondary"}>{editing ? "Done editing" : "Quick edit"}</Button>{!editing && <Button onClick={onEdit} tone="quiet">{personalOverride ? 'Edit personal version' : 'Create personal version'}</Button>}{collectionAction}</>
  const sourcePanel = <DefinitionSourcesPanel collapsed={Boolean(primarySourceId)} sources={item.entity.sources}><NativeClassSourceDetails catalog={item.catalog} entity={item.entity} onOpenDefinition={onOpenDefinition}/></DefinitionSourcesPanel>
  return <div className={`panel__body stack reference-detail${enemy && !editing ? ' reference-detail--enemy' : ''}${editing ? ' reference-detail--editing' : ''}`}>
    <div className="reference-detail__toolbar"><Button disabled={Boolean(activeEdit)} icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button>{enemy && !editing ? <ReferenceActions>{actions}<p className="definition-scope">Shared corrections apply to every playthrough in this browser. Personal versions apply only to this playthrough.</p></ReferenceActions> : <div className="cluster">{actions}</div>}</div>
    {editing && <p className="reference-edit-help">Click a highlighted value to correct the shared reference for all playthroughs in this browser.</p>}
    {enemy && !editing ? <NativeEnemyHero catalog={item.catalog} entity={item.entity} meta={modAvailability?.requiredMod && <ModBadge name={modAvailability.requiredMod} state={modAvailability.state}/>} name={<EditableReference {...editable('name', 'name')}><h2>{nativeDisplayName(item.entity)}</h2></EditableReference>} description={(record?.Description || correction?.changes.some(change => change.path === 'description') || item.entity.legacy && nativeRecord(item.entity.legacy) && item.entity.legacy.nativeDescriptionSupplemental === true) ? <EditableReference {...editable('description', 'description')}><p>{nativeRecord(item.entity.legacy) && item.entity.legacy.nativeDescriptionSupplemental === true && <Badge>Supplemental description</Badge>}<MoneyText>{nativeDisplayDescription(item.entity) ?? 'No description supplied.'}</MoneyText></p></EditableReference> : undefined}/> : <><div><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{nativeLabel ?? (supplemental ? "Supplemental source" : item.catalog.id)}</Badge>{modAvailability?.requiredMod && <ModBadge name={modAvailability.requiredMod} state={modAvailability.state}/>}{!nativeLabel && !supplemental && <Badge tone={knowledgeTone(item.catalog.applicability)}>{item.catalog.applicability.state === 'known' ? item.catalog.applicability.value : 'Applicability unknown'}</Badge>}{item.knowledgeCounts.conflicting > 0 && <Badge tone="warning">Source descriptions differ</Badge>}</div><div className="reference-title"><CatalogArtwork catalogId={item.catalog.id} detailed entity={item.entity}/><EditableReference {...editable('name', 'name')}><h2>{nativeDisplayName(item.entity)}</h2></EditableReference></div><EditableReference {...editable('description', 'description')}><p>{nativeRecord(item.entity.legacy) && item.entity.legacy.nativeDescriptionSupplemental === true && <Badge>Supplemental description</Badge>}<MoneyText>{nativeDisplayDescription(item.entity) ?? 'No raw description supplied.'}</MoneyText></p></EditableReference>{item.entity.aliases.length > 0 && <small>Aliases: {item.entity.aliases.join(', ')}</small>}<CatalogArtworkSource catalogId={item.catalog.id} entity={item.entity}/><FieldIconSources fields={item.entity.fields}/></div></>}
    {pendingCorrection && <InlineNotice title="Correction needs review" tone="warning">The original reference is shown until changed sources or competing decisions are reviewed. <Button onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'corrections' }))} tone="quiet">Review decisions</Button></InlineNotice>}
    {reviewed.map(entry => <details className="correction-applied" key={entry.id}><summary>Reviewed baseline change · {CORRECTION_DECISIONS[entry.decision]}</summary><p>{entry.reason}</p><p>{entry.evidence}</p><p>{[entry.context.platform, entry.context.gameVersion, entry.context.mods].filter(Boolean).join(' · ')}</p><CorrectionDiff changes={entry.changes}/><Button disabled={Boolean(activeEdit)} onClick={() => onOpenDefinition(entry.target)} tone="quiet">View source revision</Button></details>)}
    {correction && <div className="correction-applied"><div className="split"><span><Badge tone={correction.confidence === 'tentative' ? 'warning' : 'info'}>{correction.confidence === 'tentative' ? 'Tentative correction' : 'Corrected locally'}</Badge> {CORRECTION_DECISIONS[correction.decision]}</span><Button disabled={Boolean(activeEdit)} onClick={() => setShowOriginal(value => !value)} tone="quiet">{showOriginal ? 'View corrected' : 'View original'}</Button></div><details><summary>Why this changed</summary><p>{correction.reason || 'No explanation recorded yet.'}</p><p>{correction.evidence || 'Evidence can be added later.'}</p><p>{[correction.context.platform || 'Platform unverified', correction.context.gameVersion || 'Game version unverified', correction.context.mods || 'Enabled-mod applicability unverified'].join(' · ')}</p><CorrectionDiff changes={correction.changes}/></details></div>}
    {personalOverride?.ref.kind === 'personal' ? <InlineNotice title="Personal version available">Your preferred personal version belongs to this playthrough. <Button onClick={() => onOpenDefinition(personalOverride.ref)} tone="quiet">View personal version</Button></InlineNotice> : Object.values(item.entity.fields).some((value) => value.state === 'conflicting') && <InlineNotice title="Source descriptions differ" tone="warning"><p>Different imported values can reflect wording or scope differences. Check each source and its applicability, then keep the field unresolved or choose a claim for your personal version.</p><Button icon="edit" onClick={onEdit} tone="quiet">Review source differences</Button></InlineNotice>}
    {enemy && !editing && <><p className="enemy-input-note"><Icon name="info"/>Database inputs are shown below. Difficulty and modes can change battle values.</p><NativeEnemyStats entity={item.entity}/></>}
    <NativeDefinitionDetails catalog={item.catalog} entity={item.entity} onOpenDefinition={onOpenDefinition} technicalDetails={enemy && !editing ? <><DefinitionFactsPanel corroboration={{ catalog: item.catalog, entity: item.entity }} facts={facts} primarySourceId={primarySourceId}/><DefinitionPlanningPanel definition={item.entity}/><DefinitionSourcesPanel collapsed sources={item.entity.sources}/><CatalogArtworkSource catalogId={item.catalog.id} entity={item.entity}/><FieldIconSources fields={item.entity.fields}/></> : undefined}/>
    <ClassResearch catalog={item.catalog} definitionRef={target} entity={item.entity} key={referenceDefinitionKey(item)}/>
    {(!enemy || editing) && <div className="stack definition-detail-sections">
      <DefinitionFactsPanel corroboration={{ catalog: item.catalog, entity: item.entity }} facts={facts} primarySourceId={primarySourceId} renderValue={(field, _value, content) => <EditableReference {...editable(`field:${field}`, field)}>{content}</EditableReference>}>
        {editing && <div className="reference-add-fact"><input aria-label="Missing fact name" disabled={Boolean(activeEdit)} onChange={event => setNewFact(event.target.value)} placeholder="Add a missing fact..." value={newFact}/><Button disabled={Boolean(activeEdit) || !newFact.trim() || ['__proto__', 'prototype', 'constructor'].includes(newFact.trim())} icon="plus" onClick={() => { const name = Object.keys(item.entity.fields).find(field => field.toLocaleLowerCase() === newFact.trim().toLocaleLowerCase()) ?? newFact.trim(); setExtraFact(name); setActiveEdit(`field:${name}`); setNewFact('') }} tone="quiet">Add fact</Button></div>}
      </DefinitionFactsPanel>
      {!classDefinition && sourcePanel}
    </div>}
    {!enemy && <DefinitionPlanningPanel definition={item.entity}/>}
    {classDefinition && sourcePanel}
    {primarySourceId ? item.claims.length > 0 && <details><summary>Supplemental claims</summary><DefinitionClaimsPanel claims={item.claims}/></details> : <DefinitionClaimsPanel claims={item.claims}/> }
  </div>
}

function PersonalDetail({ option, onBack, onEdit, onOpenDefinition, collectionAction }: { option: DefinitionOption; onBack: () => void; onEdit: () => void; onOpenDefinition: (ref: EntityRef) => void; collectionAction: ReactNode }) {
  const { localData } = useDefinitionLibrary()
  const { baseline } = useCorrections()
  const definition = option.record
  const classDefinition = definition.kind === 'class'
  const root = definitionLineageRootRef(localData, option.ref)
  const source = root.kind === 'catalog' ? correctionSource(baseline, root) : undefined
  const primarySourceId = source && nativeDefinitionLabel(source.entity) ? definition.sources.find(entry => entry.sourceId.startsWith(NATIVE_SOURCE_PREFIX))?.sourceId : undefined
  const facts = visibleDefinitionFacts(definition)
  const nativeEntity = source ? { ...source.entity, name: option.name, rawDescription: option.description, aliases: definition.aliases, fields: definition.fields, sources: definition.sources } : undefined
  const enemy = nativeEntity && isNativeEnemy(nativeEntity) ? nativeEntity : undefined
  const sourcePanel = <DefinitionSourcesPanel collapsed={Boolean(primarySourceId)} sources={definition.sources}>{source && nativeEntity && <NativeClassSourceDetails catalog={source.catalog} entity={nativeEntity} onOpenDefinition={onOpenDefinition}/>}<details className="correction-disclosure"><summary>Definition history</summary><dl className="definition-list"><div className="definition-row"><dt>Revision</dt><dd>{'revision' in definition ? definition.revision : 'Catalog base'}</dd></div>{'baseRef' in definition && definition.baseRef && <div className="definition-row"><dt>Based on</dt><dd><Button onClick={() => onOpenDefinition(definition.baseRef!)} tone="quiet">View source definition</Button></dd></div>}{'previousRevision' in definition && definition.previousRevision && <div className="definition-row"><dt>Previous revision</dt><dd><Button onClick={() => onOpenDefinition(definition.previousRevision!)} tone="quiet">View previous revision</Button></dd></div>}<div className="definition-row"><dt>Exact identity</dt><dd>{option.key}</dd></div></dl></details></DefinitionSourcesPanel>
  return <div className={`panel__body stack reference-detail${enemy ? ' reference-detail--enemy' : ''}`}>
    <div className="reference-detail__toolbar"><Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button><div className="cluster"><Button icon="edit" onClick={onEdit} tone="secondary">{option.preferred ? 'Edit personal version' : 'Edit preferred personal version'}</Button>{collectionAction}</div></div>
    {enemy && source ? <NativeEnemyHero catalog={source.catalog} entity={enemy} name={<h2>{option.name}</h2>} meta={<><Badge>Personal version</Badge><Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>}</>} description={option.description !== source.entity.rawDescription || nativeSourceRecord(enemy)?.Description || nativeRecord(enemy.legacy) && enemy.legacy.nativeDescriptionSupplemental === true ? <p><MoneyText>{option.description ?? 'No description supplied.'}</MoneyText></p> : undefined}/> : <><div><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal definition</Badge>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>}<Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge></div><div className="reference-title">{source ? <CatalogArtwork catalogId={source.catalog.id} detailed entity={source.entity}/> : <ArtworkPlaceholder detailed entity={definition}/>}<h2>{option.name}</h2></div><p><MoneyText>{option.description ?? 'No raw description supplied.'}</MoneyText></p>{option.aliases.length > 0 && <small>Aliases: {option.aliases.join(', ')}</small>}{source && <CatalogArtworkSource catalogId={source.catalog.id} entity={source.entity}/>}<FieldIconSources fields={definition.fields}/></div></>}
    <p className="definition-scope">Shared personal definition. Edits save a new revision; existing records keep their saved version.</p>
    {enemy && <><p className="enemy-input-note"><Icon name="info"/>Database inputs are shown below. Difficulty and modes can change battle values.</p><NativeEnemyStats entity={enemy}/></>}
    {source && primarySourceId && <NativeDefinitionDetails catalog={source.catalog} entity={nativeEntity!} onOpenDefinition={onOpenDefinition} technicalDetails={enemy ? <><DefinitionFactsPanel facts={facts} primarySourceId={primarySourceId}/><DefinitionPlanningPanel definition={definition}/>{sourcePanel}<CatalogArtworkSource catalogId={source.catalog.id} entity={source.entity}/></> : undefined}/>}
    <ClassResearch catalog={source?.catalog} definitionRef={option.ref} entity={definition} key={option.key} sourceEntity={source?.entity}/>
    {!enemy && <div className="stack definition-detail-sections"><DefinitionFactsPanel facts={facts} primarySourceId={primarySourceId}/>{!classDefinition && sourcePanel}</div>}
    {!enemy && <DefinitionPlanningPanel definition={definition}/>}
    {classDefinition && sourcePanel}
    {(source?.claims.length ?? 0) > 0 && <details><summary>Supplemental claims</summary><DefinitionClaimsPanel claims={source?.claims ?? []}/></details>}
  </div>
}

function mergeFacetOptions(base: readonly { readonly value: string; readonly count: number }[], additions: readonly string[]) {
  const counts = new Map(base.map((option) => [option.value, option.count]))
  for (const value of additions) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value))
}

export function ReferenceView({ localData, catalogs, onOpenData, onPromoteDefinitions }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; onOpenData: () => void; onPromoteDefinitions: (sourceGameSetupRevisionId: GameSetupRevisionId, definitionRefs: readonly EntityRef[], label: string) => Promise<void> }) {
  const navigation = useNavigation()
  const { baseline } = useCorrections()
  const { options, availableOptions } = useDefinitionLibrary()
  const route = readReferenceRouteState()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [promotionRefs, setPromotionRefs] = useState<readonly EntityRef[]>([])
  const [promotionGameSetupId, setPromotionGameSetupId] = useState<GameSetupRevisionId | ''>(localData.planningGameSetupRevisionId ?? '')
  const [promotionLabel, setPromotionLabel] = useState('Reviewed personal definitions')
  const [promotionBusy, setPromotionBusy] = useState(false)
  const [promotionError, setPromotionError] = useState<string>()
  const items = useMemo(() => buildReferenceSearchItems(catalogs), [catalogs])
  const optionsByKey = useMemo(() => new Map(options.map(option => [option.key, option])), [options])
  const availableKeys = useMemo(() => new Set(availableOptions.map(option => option.key)), [availableOptions])
  const allSearchableItems = useMemo(() => items.filter(item => availableKeys.has(referenceDefinitionKey(item))).map(item => {
    const requiredMod = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability?.requiredMod
    return requiredMod ? { ...item, projection: { ...item.projection, ...referenceFieldFacets(item.entity, item.claims, requiredMod) } } : item
  }), [availableKeys, items, optionsByKey])
  const audienceOptions = useMemo(() => OPTIONAL_REFERENCE_AUDIENCES.map(audience => ({ ...audience, count: allSearchableItems.filter(item => item.audience === audience.value).length })).filter(audience => audience.count > 0), [allSearchableItems])
  const searchableItems = useMemo(() => allSearchableItems.filter(item => item.audience === 'default' || route.audiences.includes(item.audience)), [allSearchableItems, route.audiences])
  const hiddenAudienceItems = useMemo(() => allSearchableItems.filter(item => item.audience !== 'default' && !route.audiences.includes(item.audience)), [allSearchableItems, route.audiences])
  const availablePersonalOptions = useMemo(() => availableOptions.filter(option => option.ref.kind === 'personal'), [availableOptions])
  const personalOptions = useMemo(() => options.filter((option) => option.ref.kind === 'personal'), [options])
  const preferredPersonalOptions = useMemo(() => personalOptions.filter((option) => option.preferred), [personalOptions])
  const facetItems = useMemo(() => searchableItems.filter(item => !route.kinds.length || route.kinds.includes(item.entity.kind)), [searchableItems, route.kinds])
  const facetPersonalOptions = useMemo(() => availablePersonalOptions.filter(option => !route.kinds.length || route.kinds.includes(option.kind)), [availablePersonalOptions, route.kinds])
  const kindOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'kind'), availablePersonalOptions.map((option) => option.kind)), [searchableItems, availablePersonalOptions])
  const categoryOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(facetItems, 'category'), facetPersonalOptions.flatMap(personalDefinitionCategoryValues)), [facetItems, facetPersonalOptions])
  const categoryGroups = useMemo(() => {
    const kindsByCategory = new Map<string, Set<CatalogEntityKind>>()
    for (const entry of [...facetItems.map(item => ({ kind: item.entity.kind, categories: item.categories })), ...facetPersonalOptions.map(option => ({ kind: option.kind, categories: personalDefinitionCategoryValues(option) }))]) {
      for (const category of entry.categories) {
        const kinds = kindsByCategory.get(category) ?? new Set()
        kinds.add(entry.kind)
        kindsByCategory.set(category, kinds)
      }
    }
    return new Map(categoryOptions.map(option => [option.value, referenceCategoryGroup(option.value, [...(kindsByCategory.get(option.value) ?? [])])]))
  }, [categoryOptions, facetItems, facetPersonalOptions])
  const fieldFacetOptions = useMemo(() => {
    const facets: Record<ReferenceFacetKey, readonly FacetOption[]> = { classes: [], slots: [], elements: [], mods: [] }
    for (const facet of REFERENCE_FACETS) facets[facet.key] = mergeFacetOptions(buildFacetOptions(facetItems, facet.key), facetPersonalOptions.flatMap(option => personalDefinitionFacetValues(option, facet.key)))
    return facets
  }, [facetItems, facetPersonalOptions])
  const sourceOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'source'), availablePersonalOptions.map(() => 'Personal definitions')).sort((left, right) => Number(right.value.startsWith(NATIVE_SOURCE_PREFIX)) - Number(left.value.startsWith(NATIVE_SOURCE_PREFIX))), [searchableItems, availablePersonalOptions])
  const unrestrictedWeaponSkills = modState(localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined, UNRESTRICTED_WEAPON_SKILLS_MOD)
  const referenceFilters = useMemo<ReferenceFilters>(() => ({
    query: route.query,
    weapon: route.weapon,
    unrestrictedWeaponSkills,
    kinds: route.kinds,
    categories: route.categories,
    sources: route.sources,
    classes: route.classes,
    slots: route.slots,
    elements: route.elements,
    mods: route.mods,
    ...(route.ppMin === undefined && route.ppMax === undefined ? {} : { pp: { min: route.ppMin, max: route.ppMax, unit: 'PP' } }),
  }), [route.categories, route.kinds, route.ppMax, route.ppMin, route.query, route.sources, route.weapon, route.classes, route.slots, route.elements, route.mods, unrestrictedWeaponSkills])
  const partition = useMemo(() => partitionReferenceItems(searchableItems, referenceFilters), [referenceFilters, searchableItems])
  const results = useMemo(() => [...partition.confirmed, ...(!route.weapon || route.includeUncertainSkills ? partition.possible : [])], [partition.confirmed, partition.possible, route.weapon, route.includeUncertainSkills])
  const personalPartition = useMemo(() => partitionPersonalDefinitionOptions(availablePersonalOptions, referenceFilters), [availablePersonalOptions, referenceFilters])
  const personalResults = useMemo(() => [...personalPartition.confirmed, ...(!route.weapon || route.includeUncertainSkills ? personalPartition.possible : [])], [personalPartition.confirmed, personalPartition.possible, route.weapon, route.includeUncertainSkills])
  const hiddenPartition = useMemo(() => partitionReferenceItems(hiddenAudienceItems, referenceFilters), [hiddenAudienceItems, referenceFilters])
  const hiddenResults = useMemo(() => [...hiddenPartition.confirmed, ...(!route.weapon || route.includeUncertainSkills ? hiddenPartition.possible : [])], [hiddenPartition.confirmed, hiddenPartition.possible, route.weapon, route.includeUncertainSkills])
  const hiddenAudienceMatches = OPTIONAL_REFERENCE_AUDIENCES.map(audience => ({ ...audience, count: hiddenResults.filter(item => item.audience === audience.value).length })).filter(audience => audience.count > 0)
  const visiblePersonalResults = personalResults.slice(0, route.resultLimit)
  const visibleCatalogResults = results.slice(0, Math.max(0, route.resultLimit - visiblePersonalResults.length))
  const totalResults = personalResults.length + results.length
  const page = navigation.route.page.page === 'reference' ? navigation.route.page : { page: 'reference', view: 'list' } as const
  const selectedRef = page.view === 'detail' ? page.ref : undefined
  const selected = selectedRef?.kind === 'catalog' ? items.find((item) => item.catalog.id === selectedRef.catalogId && item.catalog.revisionId === selectedRef.catalogRevisionId && item.entity.id === selectedRef.entityId) : undefined
  const selectedPersonal = selectedRef?.kind === 'personal' ? findDefinitionOption(options, selectedRef) : undefined
  const selectedPreferred = selectedRef ? findDefinitionOption(options, preferredDefinitionRef(localData, selectedRef)) : undefined
  const selectedAvailability = selectedRef ? optionsByKey.get(entityDefinitionKey(selectedRef))?.modAvailability : undefined
  const missingDetail = page.view === 'detail' && !selected && !selectedPersonal
  const promoting = page.view === 'promote'
  const editorOverlay = navigation.route.overlays[0]
  const editingRef = editorOverlay?.kind === 'definition-editor' && editorOverlay.mode === 'override' ? editorOverlay.ref : undefined
  const editingOption = editingRef ? findDefinitionOption(options, editingRef) : undefined
  const missingEditingRef = Boolean(editingRef && !editingOption)
  const knowledgeCounts = useMemo(() => aggregateKnowledgeCounts(results), [results])
  const gameSetups = Object.values(localData.gameSetups).sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  const updateRoute = useCallback((change: Partial<ReferenceRouteState>, mode: 'push' | 'replace' = 'replace') => {
    commitReferenceRouteState({ ...route, ...change }, mode)
  }, [route])

  const updateFilter = useCallback((change: Partial<ReferenceRouteState>, mode: 'push' | 'replace' = 'replace') => {
    updateRoute({ ...change, selectedKey: undefined, resultLimit: REFERENCE_PAGE_SIZE }, mode)
  }, [updateRoute])

  const activeFilters: { key: string; label: string; clear: Partial<ReferenceRouteState> }[] = [
    ...(route.query ? [{ key: 'query', label: `Search: ${route.query}`, clear: { query: '' } }] : []),
    ...route.kinds.map(kind => ({ key: `kind:${kind}`, label: DEFINITION_KIND_LABELS[kind], clear: { kinds: route.kinds.filter(value => value !== kind) } })),
    ...route.categories.map(category => ({ key: `category:${category}`, label: category, clear: { categories: route.categories.filter(value => value !== category) } })),
    ...route.audiences.map(audience => ({ key: `audience:${audience}`, label: `Include ${OPTIONAL_REFERENCE_AUDIENCES.find(option => option.value === audience)!.label}`, clear: { audiences: route.audiences.filter(value => value !== audience) } })),
    ...REFERENCE_FACETS.flatMap(facet => (route[facet.key] ?? []).map(value => ({ key: `${facet.key}:${value}`, label: `${facet.label}: ${value}`, clear: { [facet.key]: route[facet.key]?.filter(entry => entry !== value) } }))),
    ...route.sources.map(source => ({ key: `source:${source}`, label: `Source: ${sourceDisplay(source).label}`, clear: { sources: route.sources.filter(value => value !== source) } })),
    ...(route.weapon ? [{ key: 'weapon', label: `Weapon skills: ${route.weapon}`, clear: { weapon: undefined, includeUncertainSkills: undefined } }] : []),
    ...(route.includeUncertainSkills ? [{ key: 'uncertainSkills', label: 'Uncertain weapon skills', clear: { includeUncertainSkills: undefined } }] : []),
    ...(route.ppMin === undefined ? [] : [{ key: 'ppMin', label: `PP minimum: ${route.ppMin}`, clear: { ppMin: undefined } }]),
    ...(route.ppMax === undefined ? [] : [{ key: 'ppMax', label: `PP maximum: ${route.ppMax}`, clear: { ppMax: undefined } }]),
  ]

  const clearFilters = () => updateFilter({ ...DEFAULT_REFERENCE_ROUTE_STATE, ...Object.fromEntries(REFERENCE_FACETS.map(facet => [facet.key, []])), weapon: undefined, includeUncertainSkills: undefined, ppMin: undefined, ppMax: undefined }, 'push')

  const navigate = (next: ReferencePageRoute, replace = false) => navigation.navigate({ ...navigation.route, page: next, overlays: [] }, { replace })
  const openDetail = (ref: EntityRef) => navigate({ page: 'reference', view: 'detail', ref })

  const promote = async () => {
    if (!promotionGameSetupId || !promotionRefs.length || !promotionLabel.trim()) return
    setPromotionBusy(true)
    setPromotionError(undefined)
    try {
      await onPromoteDefinitions(promotionGameSetupId, promotionRefs, promotionLabel.trim())
      setPromotionRefs([])
      navigation.close()
    } catch (reason) {
      setPromotionError(formatAppError(reason, 'The Game Setup revision could not be created.'))
    } finally {
      setPromotionBusy(false)
    }
  }

  const hiddenMatchNotice = route.query && hiddenAudienceMatches.length > 0 ? <InlineNotice title={`${hiddenResults.length} additional ${hiddenResults.length === 1 ? 'match is' : 'matches are'} hidden`} tone="warning"><p>The default Reference omits technical and supplemental material. Include a matching category to see these results.</p><div className="cluster">{hiddenAudienceMatches.map(audience => <Button key={audience.value} onClick={() => updateFilter({ audiences: [...route.audiences, audience.value] }, 'push')} tone="quiet">Show {audience.label}</Button>)}</div></InlineNotice> : null

  const collectionAction = <Button disabled={!preferredPersonalOptions.length || !gameSetups.length} icon="layers" onClick={() => { setPromotionRefs(preferredPersonalOptions.map(option => option.ref)); navigate({ page: 'reference', view: 'promote' }) }} tone="secondary">Collect into Game Setup revision</Button>

  return <>
    {selectedRef ? <h1 className="sr-only">Reference</h1> : <ScreenHeader actions={<><CorrectionsButton/>{collectionAction}<Button icon="upload" onClick={onOpenData} tone="secondary">Import reference</Button></>} description="Look up equipment, classes, abilities, and monsters from the bundled game data." eyebrow="Game reference" title="Reference"/>}
    {!selectedRef && activeFilters.length > 0 && <div aria-label="Active reference filters" className="reference-active-filters" role="group">{activeFilters.map(filter => <button aria-label={`Remove ${filter.label} filter`} className="filter-chip" key={filter.key} onClick={() => updateFilter(filter.clear, 'push')} title={filter.label} type="button"><span>{filter.label}</span><Icon name="close"/></button>)}<Button onClick={clearFilters} tone="quiet">Clear all filters</Button></div>}
    {!selectedRef && availableOptions.length < options.length && <p className="settings-section__intro">Definitions from explicitly disabled mods are hidden. Unclassified entries and uncertain mod settings remain visible.</p>}
    {missingDetail && <InlineNotice title="Reference definition unavailable" tone="warning">The requested exact definition is not available in this planner. It may belong to another catalog revision, an older backup, or another playthrough. <Button onClick={() => navigate({ page: 'reference', view: 'list' })} tone="quiet">Return to reference</Button></InlineNotice>}
    {catalogs.length === 0 && personalOptions.length === 0 ? <EmptyState aside={<>Personal records remain available even if a local reference pack cannot be loaded.</>} description="No reference pack is available in this planner. Import a permitted pack locally and review its format, rights, and coverage before adding it." icon="book" title="Reference library is empty"><Button icon="upload" onClick={onOpenData}>Import a reference pack</Button></EmptyState> : <div className={`reference-layout${selectedRef ? ' reference-layout--detail' : ''}`}>
      {!selectedRef && <aside className="panel facet-panel">
        <div className="panel__header"><div><h2>Refine</h2><p>{partition.confirmed.length + personalPartition.confirmed.length} confirmed · {partition.possible.length + personalPartition.possible.length} possible</p></div></div>
        <div className="facet-group"><div className="search-field"><Icon name="search"/><input aria-label="Search reference" onChange={(event) => updateFilter({ query: event.target.value })} placeholder="Name, alias, or raw text" type="search" value={route.query}/></div></div>
        <button aria-controls="reference-filter-options" aria-expanded={filtersOpen} className="mobile-filter-toggle" onClick={() => setFiltersOpen((value) => !value)} type="button"><span>{filtersOpen ? 'Hide filters' : 'Filters'}</span><Badge>{activeFilters.length} active</Badge></button>
        <div className={`reference-filter-options${filtersOpen ? ' is-open' : ''}`} id="reference-filter-options">
          <ReferenceFacetSection active={route.kinds.length} summary="All definitions" title="Definition type">
            <div aria-label="Reference definition type filters" className="reference-kind-groups" role="group">
              <button aria-pressed={route.kinds.length === 0} className="filter-chip" onClick={() => updateFilter({ kinds: [] }, 'push')} type="button">All types</button>
              {DEFINITION_KIND_GROUPS.map(group => <div key={group.label}><h4>{group.label}</h4><div className="reference-kind-options">{group.kinds.flatMap(kind => {
                const option = kindOptions.find(entry => entry.value === kind)
                return option ? [<button aria-pressed={route.kinds.includes(kind)} className="filter-chip" key={kind} onClick={() => updateFilter({ kinds: toggleValue(route.kinds, kind) as typeof route.kinds }, 'push')} type="button">{DEFINITION_KIND_LABELS[kind]} <span className="filter-chip__count">{option.count}</span></button>] : []
              })}</div></div>)}
            </div>
          </ReferenceFacetSection>
          <ReferenceFacetSection active={route.audiences.length} summary="Game & planning only" title="Additional reference">
            <p className="settings-section__intro">Game and planning records are always included. Add technical or supplemental material when you need it.</p>
            <div aria-label="Additional reference filters" className="reference-kind-options" role="group">{audienceOptions.map(audience => <button aria-pressed={route.audiences.includes(audience.value)} className="filter-chip" key={audience.value} onClick={() => updateFilter({ audiences: toggleValue(route.audiences, audience.value) as readonly OptionalReferenceAudience[] }, 'push')} title={audience.description} type="button">{audience.label} <span className="filter-chip__count">{audience.count}</span></button>)}</div>
          </ReferenceFacetSection>
          {categoryOptions.length > 0 && <div className="facet-group"><h3>Category</h3><ReferenceCategoryFilters groups={categoryGroups} onClear={() => updateFilter({ categories: [] }, 'push')} onToggle={value => updateFilter({ categories: toggleValue(route.categories, value) }, 'push')} options={categoryOptions} selected={route.categories}/><small className="bounded-facet-options__summary">Choose alternatives within a filter. Different filters narrow the results together.</small></div>}
          {REFERENCE_FACETS.map(facet => fieldFacetOptions[facet.key].length || route[facet.key]?.length ? <ReferenceFacetSection active={route[facet.key]?.length ?? 0} key={facet.key} title={facet.label}><BoundedFacetOptions alwaysSearch groupLabel={`Reference ${facet.key} filters`} onClear={() => updateFilter({ [facet.key]: [] }, 'push')} onToggle={value => updateFilter({ [facet.key]: toggleValue(route[facet.key] ?? [], value) }, 'push')} options={fieldFacetOptions[facet.key]} searchLabel={`Search reference ${facet.key}`} selected={route[facet.key] ?? []}/></ReferenceFacetSection> : null)}
          {!selectedRef && <ReferenceFacetSection active={route.weapon ? 1 : 0} title="Weapon skills"><label className="field"><span className="field__label">Weapon skills usable with</span><select onChange={event => updateFilter({ weapon: normalizeWeaponType(event.target.value), kinds: [], categories: [], slots: [], ppMin: undefined, ppMax: undefined }, 'push')} value={route.weapon ?? ''}><option value="">Any skill or definition</option>{WEAPON_TYPES.map(weapon => <option key={weapon} value={weapon}>{weapon}</option>)}</select></label></ReferenceFacetSection>}
          <ReferenceFacetSection active={(route.ppMin === undefined ? 0 : 1) + (route.ppMax === undefined ? 0 : 1)} title="PP cost"><div className="grid-2"><label className="field"><span className="field__label">Minimum</span><input inputMode="numeric" onChange={(event) => updateFilter({ ppMin: numericInput(event.target.value) })} type="number" value={route.ppMin ?? ''}/></label><label className="field"><span className="field__label">Maximum</span><input inputMode="numeric" onChange={(event) => updateFilter({ ppMax: numericInput(event.target.value) })} type="number" value={route.ppMax ?? ''}/></label></div><small>PP bounds apply only where PP is meaningful. Unknown or conflicting costs remain possible matches.</small></ReferenceFacetSection>
          <ReferenceFacetSection active={route.sources.length} title="Source"><BoundedFacetOptions formatOption={sourceDisplay} groupLabel="Reference source filters" onClear={() => updateFilter({ sources: [] }, 'push')} onToggle={(value) => updateFilter({ sources: toggleValue(route.sources, value) }, 'push')} options={sourceOptions} searchLabel="Search reference sources" selected={route.sources}/></ReferenceFacetSection>
          <ReferenceFacetSection summary="Knowledge & reference packs" title="Library details">
            <h4>Catalog knowledge in matches</h4><div className="reference-knowledge"><Badge tone="positive">{knowledgeCounts.known} known</Badge><Badge tone="warning">{knowledgeCounts.unknown} unknown</Badge><Badge tone="danger">{knowledgeCounts.conflicting} source differences</Badge></div>
            <h4>Reference packs</h4>{catalogs.map(catalog => <div className="source-claim" key={JSON.stringify([catalog.id, catalog.revisionId])}><span className="source-claim__line"/><div><strong>{catalog.id}</strong><p>Revision {catalog.revisionId}</p><small>{catalog.schemaVersion} · {Object.keys(catalog.entities).length} definitions</small></div></div>)}
            {personalOptions.length > 0 && <><h4>Personal definitions</h4><p className="settings-section__intro">{preferredPersonalOptions.length} preferred immutable {preferredPersonalOptions.length === 1 ? 'lineage' : 'lineages'} plus {personalOptions.length - preferredPersonalOptions.length} historical revisions. Filters and results keep exact identities visible.</p></>}
          </ReferenceFacetSection>
        </div>
      </aside>}
      <section className={selected && isNativeEnemy(selected.entity) ? "reference-entry" : "panel"}>
        {!selectedRef && route.weapon && <div className="panel__header"><div><h2>Skills usable with {route.weapon}</h2><p>Weapon skills only, including multi-weapon and any-weapon skills.</p>{partition.possible.length + personalPartition.possible.length > 0 && <label className="check-row"><input checked={route.includeUncertainSkills ?? false} onChange={event => updateFilter({ includeUncertainSkills: event.target.checked }, 'push')} type="checkbox"/><span>Include skills with unknown or conflicting requirements ({partition.possible.length + personalPartition.possible.length})</span></label>}{unrestrictedWeaponSkills === 'enabled' && <p>Unrestricted Weapon Skills is enabled. All documented weapon skills match; their original weapon requirements are shown below.</p>}</div></div>}
        {selectedPersonal ? <PersonalDetail collectionAction={collectionAction} key={selectedPersonal.key} onOpenDefinition={openDetail} onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(localData, selectedPersonal.ref) }))} option={selectedPersonal}/> : selected ? <DetailView collectionAction={collectionAction} key={selected.key} item={selected} modAvailability={selectedAvailability} onOpenDefinition={openDetail} personalOverride={selectedPreferred?.ref.kind === 'personal' ? selectedPreferred : undefined} onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(localData, { kind: 'catalog', catalogId: selected.catalog.id, catalogRevisionId: selected.catalog.revisionId, entityId: selected.entity.id }) }))}/> : results.length || personalResults.length ? <div>
          {hiddenMatchNotice && <div className="panel__body">{hiddenMatchNotice}</div>}
          {partition.confirmed.length + personalPartition.confirmed.length === 0 && partition.possible.length + personalPartition.possible.length > 0 && <div className="panel__body"><InlineNotice title="Only possible matches">Unknown or conflicting fields may satisfy the active filters. Review each source before relying on it.</InlineNotice></div>}
          {visiblePersonalResults.map((option) => {
            const possible = personalPartition.possible.includes(option)
            const root = definitionLineageRootRef(localData, option.ref)
            const source = root.kind === 'catalog' ? correctionSource(baseline, root) : undefined
            return <NavigationLink className="reference-card" key={option.key} route={routeForSearchTarget({ kind: 'definition', ref: option.ref })} onNavigate={() => openDetail(option.ref)} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }}><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal</Badge>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>} {possible && <Badge tone="warning">Possible match</Badge>}<Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge>{option.ppCost?.state === 'known' && <Badge tone="info">{option.ppCost.value} PP</Badge>}</div><div className="reference-title">{source ? <CatalogArtwork catalogId={source.catalog.id} entity={source.entity}/> : <ArtworkPlaceholder entity={option.record}/>}<h3>{option.name}</h3></div>{route.weapon && <SkillSummary entity={option.record}/>}<p><MoneyText>{option.description ?? `${option.sourceLabel} · ${option.stockLabel}`}</MoneyText></p></NavigationLink>
          })}
          {visibleCatalogResults.map((item) => { const nativeLabel = nativeDefinitionLabel(item.entity); const possible = partition.possible.includes(item); const availability = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability; const ref: EntityRef = { kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id }; return <NavigationLink className="reference-card" key={item.key} route={routeForSearchTarget({ kind: 'definition', ref })} onNavigate={() => openDetail(ref)} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }}><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{nativeLabel ?? (nativeRecord(item.entity.legacy) && item.entity.legacy.supplemental === true ? "Supplemental source" : item.catalog.id)}</Badge>{availability?.requiredMod && <ModBadge name={availability.requiredMod} state={availability.state}/>} {possible && <Badge tone="warning">Possible match</Badge>}{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">Sources differ</Badge>}{(item.entity.kind === 'passive' || item.entity.kind === 'innate') && <Badge tone={item.ppCost.state === 'known' ? 'info' : item.ppCost.state === 'conflicting' ? 'danger' : 'warning'}>{ppLabel(item)}</Badge>}</div><div className="reference-title"><CatalogArtwork catalogId={item.catalog.id} entity={item.entity}/><h3>{nativeDisplayName(item.entity)}</h3></div>{route.weapon && <SkillSummary entity={item.entity}/>}<p>{nativeRecord(item.entity.legacy) && item.entity.legacy.nativeDescriptionSupplemental === true && <Badge>Supplemental description</Badge>}<MoneyText>{nativeDisplayDescription(item.entity) ?? `${Object.keys(item.entity.fields).length} normalized fields · ${item.claims.length} source claims`}</MoneyText></p></NavigationLink> })}
          {totalResults > route.resultLimit && route.resultLimit < ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><Button onClick={() => updateRoute({ resultLimit: Math.min(ROUTE_MAX_RESULT_LIMIT, route.resultLimit + REFERENCE_PAGE_SIZE) }, 'replace')} tone="secondary">Show {Math.min(REFERENCE_PAGE_SIZE, totalResults - route.resultLimit)} more</Button></div>}
          {totalResults > ROUTE_MAX_RESULT_LIMIT && route.resultLimit >= ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><InlineNotice title="Result display limit reached">Refine the name, category, source, type, or PP filters to reach entries beyond the first {ROUTE_MAX_RESULT_LIMIT.toLocaleString()} matches.</InlineNotice></div>}
        </div> : <div className="panel__body">{hiddenMatchNotice ?? <InlineNotice title="No matches">Unknown fields are kept as possible only when they could satisfy every active filter. Try another name, category, source, kind, or PP bound.</InlineNotice>}</div>}
      </section>
    </div>}
    {missingEditingRef && <InlineNotice title="Definition override unavailable" tone="warning">The exact definition selected for this override is unavailable. Close this editor address and choose an available definition without changing the original reference. <Button onClick={() => navigation.close()} tone="quiet">Close editor</Button></InlineNotice>}
    {editingRef && editingOption && <DefinitionEditor allowedKinds={[]} baseRef={editingRef} key={entityDefinitionKey(editingRef)} onClose={() => navigation.close()} onSaved={(ref) => navigation.navigate({ ...navigation.route, page: { page: 'reference', view: 'detail', ref }, overlays: [] }, { replace: true })} open routeIndex={0}/>}
    <Sheet description="Collect reviewed preferred personal definitions into a new immutable Game Setup revision. Existing build checkpoints keep their exact references, and the current Game Setup does not change." onClose={() => navigation.close()} open={promoting} title="Collect into Game Setup revision" width="wide"><div className="stack">
      <InlineNotice title="Promotion-ready collection">This creates a new Game Setup revision from the selected source. It does not publish a catalog, rewrite old records, or activate the new revision.</InlineNotice>
      <div className="grid-2"><label className="field"><span className="field__label">Source Game Setup revision</span><select onChange={(event) => setPromotionGameSetupId(event.target.value as GameSetupRevisionId)} value={promotionGameSetupId}><option value="">Choose Game Setup revision</option>{gameSetups.map((gameSetup) => <option key={gameSetup.id} value={gameSetup.id}>{gameSetup.label} · revision {gameSetup.revision}</option>)}</select></label><label className="field"><span className="field__label">New revision label</span><input onChange={(event) => setPromotionLabel(event.target.value)} required value={promotionLabel}/></label></div>
      <fieldset className="definition-collection"><legend>Preferred personal definitions</legend>{preferredPersonalOptions.map((option) => { const checked = promotionRefs.some((ref) => entityDefinitionKey(ref) === option.key); return <label className="check-row" key={option.key}><input checked={checked} onChange={(event) => setPromotionRefs((current) => event.target.checked ? [...current, option.ref] : current.filter((ref) => entityDefinitionKey(ref) !== option.key))} type="checkbox"/><span><strong>{option.name}</strong><small>{option.kind} · {option.sourceLabel}</small></span></label> })}</fieldset>
      {promotionError && <InlineNotice title="Game Setup revision not created" tone="danger">{promotionError} Your selected definitions remain checked.</InlineNotice>}
      <div className="form-actions"><Button disabled={promotionBusy} onClick={() => navigation.close()} tone="quiet">Cancel</Button><Button disabled={promotionBusy || !promotionGameSetupId || !promotionRefs.length || !promotionLabel.trim()} icon="check" onClick={() => void promote()}>{promotionBusy ? 'Creating revision...' : 'Create Game Setup revision'}</Button></div>
    </div></Sheet>
  </>
}
