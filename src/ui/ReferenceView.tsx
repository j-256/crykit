import { activeCorrections, CORRECTION_DECISIONS, correctionKey, correctionSource, correctionStatus } from '../domain/corrections'
import { useCorrections } from './corrections-context'
import { CorrectionsButton } from './Corrections'
import { EditableReference, type EditableReferencePath } from './InlineCorrection'
import { CorrectionDiff } from './CorrectionEditor'
import { DefinitionClaimsPanel, DefinitionFactsPanel, DefinitionPlanningPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { reviewedCatalogDecisions } from '../interchange/correction-promotion'
import { modState } from '../domain/mods'
import { normalizeWeaponType, skillWeaponLabel, skillWeaponRule, UNRESTRICTED_WEAPON_SKILLS_MOD, WEAPON_TYPES } from '../domain/skill-weapons'
import { modAvailabilityLabel } from '../catalog/mods'
import { useCallback, useMemo, useState } from 'react'
import { definitionLineageRootRef, entityDefinitionKey, preferredDefinitionRef } from '../domain'
import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, CatalogRef, EntityRef, Profile, RulesetRevisionId } from '../domain/types'
import { Badge, BoundedFacetOptions, Button, EmptyState, InlineNotice, ScreenHeader } from './components'
import { Icon } from './icons'
import { formatAppError, knowledgeTone } from './model'
import { DefinitionEditor, findDefinitionOption, useDefinitionWorkspace, type DefinitionOption } from './definitions'
import { routeWithOverlay, useNavigation, type ReferencePageRoute } from './navigation'
import { Sheet } from './Sheet'
import { KnowledgeValue } from './KnowledgeValue'
import { ArtworkPlaceholder, WikiSprite, WikiSpriteSource } from './WikiSprite'
import { FieldIconSources } from './GameIcon'
import { sourceDisplay } from './source-display'
import { ClassResearch } from './ClassResearch'
import { CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import { ReferenceCategoryFilters, ReferenceFacetSection } from './ReferenceFacets'
import { DEFINITION_KIND_GROUPS, DEFINITION_KIND_LABELS, referenceCategoryGroup, referenceFieldFacets, REFERENCE_FACETS, type ReferenceFacetKey } from './reference-facets'
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

function DetailView({ item: displayedItem, onBack, onEdit, personalOverride, onOpenDefinition }: { item: ReferenceSearchItem; onBack: () => void; onEdit: () => void; personalOverride?: DefinitionOption; onOpenDefinition: (ref: EntityRef) => void }) {
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
  const facts = Object.entries(item.entity.fields).filter(([field]) => editing || field !== CRYSTAL_EDIT_FIELDS.tree && field !== 'Crystal Edit source record')
  if (extraFact && !Object.hasOwn(item.entity.fields, extraFact)) facts.push([extraFact, { state: 'unknown' }])
  return <div className={`panel__body stack reference-detail${editing ? ' reference-detail--editing' : ''}`}>
    <div className="split"><Button disabled={Boolean(activeEdit)} icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button><div className="cluster"><Button disabled={Boolean(activeEdit)} icon="edit" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'correction-editor', ref: target }))} tone="secondary">Correct shared reference</Button><Button aria-pressed={editing} disabled={Boolean(activeEdit) || showOriginal} icon={editing ? "check" : "edit"} onClick={() => setEditing(value => !value)} tone={editing ? "primary" : "secondary"}>{editing ? "Done editing" : "Quick edit"}</Button>{!editing && <Button onClick={onEdit} tone="quiet">{personalOverride ? 'Edit personal version' : 'Create personal version'}</Button>}</div></div>
    {editing ? <p className="reference-edit-help">Click a highlighted value to correct the shared reference for all playthroughs in this browser.</p> : <p className="definition-scope">Shared corrections apply to every playthrough in this browser. Personal versions apply only to this playthrough.</p>}
    <div><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{item.catalog.id}</Badge><Badge tone={knowledgeTone(item.catalog.applicability)}>{item.catalog.applicability.state === 'known' ? item.catalog.applicability.value : 'Applicability unknown'}</Badge>{item.knowledgeCounts.conflicting > 0 && <Badge tone="warning">Source descriptions differ</Badge>}</div><div className="reference-title"><WikiSprite catalogId={item.catalog.id} detailed entity={item.entity}/><EditableReference {...editable('name', 'name')}><h2>{item.entity.name}</h2></EditableReference></div><EditableReference {...editable('description', 'description')}><p>{item.entity.rawDescription ?? 'No raw description supplied.'}</p></EditableReference>{item.entity.aliases.length > 0 && <small>Aliases: {item.entity.aliases.join(', ')}</small>}<WikiSpriteSource catalogId={item.catalog.id} entity={item.entity}/><FieldIconSources fields={item.entity.fields}/></div>
    {pendingCorrection && <InlineNotice title="Correction needs review" tone="warning">The original reference is shown until changed sources or competing decisions are reviewed. <Button onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'corrections' }))} tone="quiet">Review decisions</Button></InlineNotice>}
    {reviewed.map(entry => <details className="correction-applied" key={entry.id}><summary>Reviewed baseline change · {CORRECTION_DECISIONS[entry.decision]}</summary><p>{entry.reason}</p><p>{entry.evidence}</p><p>{[entry.context.platform, entry.context.gameVersion, entry.context.mods].filter(Boolean).join(' · ')}</p><CorrectionDiff changes={entry.changes}/><Button disabled={Boolean(activeEdit)} onClick={() => onOpenDefinition(entry.target)} tone="quiet">View source revision</Button></details>)}
    {correction && <div className="correction-applied"><div className="split"><span><Badge tone={correction.confidence === 'tentative' ? 'warning' : 'info'}>{correction.confidence === 'tentative' ? 'Tentative correction' : 'Corrected locally'}</Badge> {CORRECTION_DECISIONS[correction.decision]}</span><Button disabled={Boolean(activeEdit)} onClick={() => setShowOriginal(value => !value)} tone="quiet">{showOriginal ? 'View corrected' : 'View original'}</Button></div><details><summary>Why this changed</summary><p>{correction.reason || 'No explanation recorded yet.'}</p><p>{correction.evidence || 'Evidence can be added later.'}</p><p>{[correction.context.platform || 'Platform unverified', correction.context.gameVersion || 'Game version unverified', correction.context.mods || 'Enabled-mod applicability unverified'].join(' · ')}</p><CorrectionDiff changes={correction.changes}/></details></div>}
    {personalOverride?.ref.kind === 'personal' ? <InlineNotice title="Personal version available">Your preferred personal version belongs to this playthrough. <Button onClick={() => onOpenDefinition(personalOverride.ref)} tone="quiet">View personal version</Button></InlineNotice> : Object.values(item.entity.fields).some((value) => value.state === 'conflicting') && <InlineNotice title="Source descriptions differ" tone="warning"><p>Different imported values can reflect wording or scope differences. Check each source and its applicability, then keep the field unresolved or choose a claim for your personal version.</p><Button icon="edit" onClick={onEdit} tone="quiet">Review source differences</Button></InlineNotice>}
    <ClassResearch catalog={item.catalog} definitionRef={target} entity={item.entity} key={referenceDefinitionKey(item)}/>
    <div className="grid-2 definition-detail-columns">
      <DefinitionFactsPanel facts={facts} renderValue={(field, _value, content) => <EditableReference {...editable(`field:${field}`, field)}>{content}</EditableReference>}>
        {editing && <div className="reference-add-fact"><input aria-label="Missing fact name" disabled={Boolean(activeEdit)} onChange={event => setNewFact(event.target.value)} placeholder="Add a missing fact..." value={newFact}/><Button disabled={Boolean(activeEdit) || !newFact.trim() || ['__proto__', 'prototype', 'constructor'].includes(newFact.trim())} icon="plus" onClick={() => { const name = Object.keys(item.entity.fields).find(field => field.toLocaleLowerCase() === newFact.trim().toLocaleLowerCase()) ?? newFact.trim(); setExtraFact(name); setActiveEdit(`field:${name}`); setNewFact('') }} tone="quiet">Add fact</Button></div>}
      </DefinitionFactsPanel>
      <DefinitionSourcesPanel sources={item.entity.sources}/>
    </div>
    <DefinitionPlanningPanel definition={item.entity}/>
    <DefinitionClaimsPanel claims={item.claims}/>
  </div>
}

function PersonalDetail({ option, onBack, onEdit, onOpenDefinition }: { option: DefinitionOption; onBack: () => void; onEdit: () => void; onOpenDefinition: (ref: EntityRef) => void }) {
  const { profile } = useDefinitionWorkspace()
  const { baseline } = useCorrections()
  const definition = option.record
  const root = definitionLineageRootRef(profile, option.ref)
  const source = root.kind === 'catalog' ? correctionSource(baseline, root) : undefined
  const facts = Object.entries(definition.fields).filter(([field]) => field !== CRYSTAL_EDIT_FIELDS.tree && field !== 'Crystal Edit source record')
  return <div className="panel__body stack reference-detail">
    <div className="split"><Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button><Button icon="edit" onClick={onEdit} tone="secondary">{option.preferred ? 'Edit personal version' : 'Edit preferred personal version'}</Button></div>
    <div><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal definition</Badge><Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge></div><div className="reference-title">{source ? <WikiSprite catalogId={source.catalog.id} detailed entity={source.entity}/> : <ArtworkPlaceholder detailed entity={definition}/>}<h2>{option.name}</h2></div><p>{option.description ?? 'No raw description supplied.'}</p>{option.aliases.length > 0 && <small>Aliases: {option.aliases.join(', ')}</small>}{source && <WikiSpriteSource catalogId={source.catalog.id} entity={source.entity}/>}<FieldIconSources fields={definition.fields}/></div>
    <p className="definition-scope">Personal definition for {profile.label}. Edits save a new revision; existing records keep their saved version.</p>
    <ClassResearch catalog={source?.catalog} definitionRef={option.ref} entity={definition} key={option.key}/>
    <div className="grid-2 definition-detail-columns"><DefinitionFactsPanel facts={facts}/><DefinitionSourcesPanel sources={definition.sources}><details className="correction-disclosure"><summary>Definition history</summary><dl className="definition-list"><div className="definition-row"><dt>Revision</dt><dd>{'revision' in definition ? definition.revision : 'Catalog base'}</dd></div>{'baseRef' in definition && definition.baseRef && <div className="definition-row"><dt>Based on</dt><dd><Button onClick={() => onOpenDefinition(definition.baseRef!)} tone="quiet">View source definition</Button></dd></div>}{'previousRevision' in definition && definition.previousRevision && <div className="definition-row"><dt>Previous revision</dt><dd><Button onClick={() => onOpenDefinition(definition.previousRevision!)} tone="quiet">View previous revision</Button></dd></div>}<div className="definition-row"><dt>Exact identity</dt><dd>{option.key}</dd></div></dl></details></DefinitionSourcesPanel></div>
    <DefinitionPlanningPanel definition={definition}/>
    <DefinitionClaimsPanel claims={source?.claims ?? []}/>
  </div>
}

function mergeFacetOptions(base: readonly { readonly value: string; readonly count: number }[], additions: readonly string[]) {
  const counts = new Map(base.map((option) => [option.value, option.count]))
  for (const value of additions) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value))
}

export function ReferenceView({ profile, catalogs, onOpenData, onPromoteDefinitions }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; onOpenData: () => void; onPromoteDefinitions: (sourceRulesetRevisionId: RulesetRevisionId, definitionRefs: readonly EntityRef[], label: string) => Promise<void> }) {
  const navigation = useNavigation()
  const { baseline } = useCorrections()
  const { options, availableOptions } = useDefinitionWorkspace()
  const route = readReferenceRouteState()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [promotionRefs, setPromotionRefs] = useState<readonly EntityRef[]>([])
  const [promotionRulesetId, setPromotionRulesetId] = useState<RulesetRevisionId | ''>(profile.activeRulesetRevisionId ?? '')
  const [promotionLabel, setPromotionLabel] = useState('Reviewed personal definitions')
  const [promotionBusy, setPromotionBusy] = useState(false)
  const [promotionError, setPromotionError] = useState<string>()
  const items = useMemo(() => buildReferenceSearchItems(catalogs), [catalogs])
  const optionsByKey = useMemo(() => new Map(options.map(option => [option.key, option])), [options])
  const availableKeys = useMemo(() => new Set(availableOptions.map(option => option.key)), [availableOptions])
  const searchableItems = useMemo(() => items.filter(item => availableKeys.has(referenceDefinitionKey(item))).map(item => {
    const requiredMod = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability?.requiredMod
    return requiredMod ? { ...item, projection: { ...item.projection, ...referenceFieldFacets(item.entity, item.claims, requiredMod) } } : item
  }), [availableKeys, items, optionsByKey])
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
  const sourceOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'source'), availablePersonalOptions.map(() => 'Personal definitions')), [searchableItems, availablePersonalOptions])
  const unrestrictedWeaponSkills = modState(profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined, UNRESTRICTED_WEAPON_SKILLS_MOD)
  const partition = useMemo(() => partitionReferenceItems(searchableItems, {
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
  }), [searchableItems, route.categories, route.kinds, route.ppMax, route.ppMin, route.query, route.sources, route.weapon, route.classes, route.slots, route.elements, route.mods, unrestrictedWeaponSkills])
  const results = useMemo(() => [...partition.confirmed, ...(!route.weapon || route.includeUncertainSkills ? partition.possible : [])], [partition.confirmed, partition.possible, route.weapon, route.includeUncertainSkills])
  const personalPartition = useMemo(() => partitionPersonalDefinitionOptions(availablePersonalOptions, {
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
  }), [availablePersonalOptions, route.categories, route.kinds, route.ppMax, route.ppMin, route.query, route.sources, route.weapon, route.classes, route.slots, route.elements, route.mods, unrestrictedWeaponSkills])
  const personalResults = useMemo(() => [...personalPartition.confirmed, ...(!route.weapon || route.includeUncertainSkills ? personalPartition.possible : [])], [personalPartition.confirmed, personalPartition.possible, route.weapon, route.includeUncertainSkills])
  const visiblePersonalResults = personalResults.slice(0, route.resultLimit)
  const visibleCatalogResults = results.slice(0, Math.max(0, route.resultLimit - visiblePersonalResults.length))
  const totalResults = personalResults.length + results.length
  const page = navigation.route.page.page === 'reference' ? navigation.route.page : { page: 'reference', view: 'list' } as const
  const selectedRef = page.view === 'detail' ? page.ref : undefined
  const selected = selectedRef?.kind === 'catalog' ? items.find((item) => item.catalog.id === selectedRef.catalogId && item.catalog.revisionId === selectedRef.catalogRevisionId && item.entity.id === selectedRef.entityId) : undefined
  const selectedPersonal = selectedRef?.kind === 'personal' ? findDefinitionOption(options, selectedRef) : undefined
  const selectedPreferred = selectedRef ? findDefinitionOption(options, preferredDefinitionRef(profile, selectedRef)) : undefined
  const selectedAvailability = selectedRef ? optionsByKey.get(entityDefinitionKey(selectedRef))?.modAvailability : undefined
  const missingDetail = page.view === 'detail' && !selected && !selectedPersonal
  const promoting = page.view === 'promote'
  const editorOverlay = navigation.route.overlays[0]
  const editingRef = editorOverlay?.kind === 'definition-editor' && editorOverlay.mode === 'override' ? editorOverlay.ref : undefined
  const editingOption = editingRef ? findDefinitionOption(options, editingRef) : undefined
  const missingEditingRef = Boolean(editingRef && !editingOption)
  const knowledgeCounts = useMemo(() => aggregateKnowledgeCounts(results), [results])
  const rulesets = Object.values(profile.rulesets).sort((left, right) => right.createdAt.localeCompare(left.createdAt))

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
    if (!promotionRulesetId || !promotionRefs.length || !promotionLabel.trim()) return
    setPromotionBusy(true)
    setPromotionError(undefined)
    try {
      await onPromoteDefinitions(promotionRulesetId, promotionRefs, promotionLabel.trim())
      setPromotionRefs([])
      navigation.close()
    } catch (reason) {
      setPromotionError(formatAppError(reason, 'The ruleset revision could not be created.'))
    } finally {
      setPromotionBusy(false)
    }
  }

  return <>
    <ScreenHeader actions={<><CorrectionsButton/><Button disabled={!preferredPersonalOptions.length || !rulesets.length} icon="layers" onClick={() => { setPromotionRefs(preferredPersonalOptions.map((option) => option.ref)); navigate({ page: 'reference', view: 'promote' }) }} tone="secondary">Collect into ruleset revision</Button><Button icon="upload" onClick={onOpenData} tone="secondary">Import reference</Button></>} description="Look up equipment, classes, abilities, and monsters. Check sources and unknown details before planning." eyebrow="Game reference" title="Reference"/>
    {activeFilters.length > 0 && <div aria-label="Active reference filters" className="reference-active-filters" role="group">{activeFilters.map(filter => <button aria-label={`Remove ${filter.label} filter`} className="filter-chip" key={filter.key} onClick={() => updateFilter(filter.clear, 'push')} title={filter.label} type="button"><span>{filter.label}</span><Icon name="close"/></button>)}<Button onClick={clearFilters} tone="quiet">Clear all filters</Button></div>}
    {!selectedRef && availableOptions.length < options.length && <p className="settings-section__intro">Definitions from explicitly disabled mods are hidden. Unclassified entries and uncertain mod settings remain visible.</p>}
    {selectedAvailability?.requiredMod && <p className="settings-section__intro">{modAvailabilityLabel(selectedAvailability)}</p>}
    {missingDetail && <InlineNotice title="Reference definition unavailable" tone="warning">The requested exact definition is not available in this workspace. It may belong to another catalog revision, an older backup, or another playthrough. <Button onClick={() => navigate({ page: 'reference', view: 'list' })} tone="quiet">Return to reference</Button></InlineNotice>}
    {catalogs.length === 0 && personalOptions.length === 0 ? <EmptyState aside={<>Personal records remain available even if a local reference pack cannot be loaded.</>} description="No reference pack is available in this workspace. Import a permitted pack locally and review its format, rights, and coverage before adding it." icon="book" title="Reference library is empty"><Button icon="upload" onClick={onOpenData}>Import a reference pack</Button></EmptyState> : <div className="reference-layout">
      <aside className="panel facet-panel">
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
      </aside>
      <section className="panel">
        {!selectedRef && route.weapon && <div className="panel__header"><div><h2>Skills usable with {route.weapon}</h2><p>Weapon skills only, including multi-weapon and any-weapon skills.</p>{partition.possible.length + personalPartition.possible.length > 0 && <label className="check-row"><input checked={route.includeUncertainSkills ?? false} onChange={event => updateFilter({ includeUncertainSkills: event.target.checked }, 'push')} type="checkbox"/><span>Include skills with unknown or conflicting requirements ({partition.possible.length + personalPartition.possible.length})</span></label>}{unrestrictedWeaponSkills === 'enabled' && <p>Unrestricted Weapon Skills is enabled. All documented weapon skills match; their original weapon requirements are shown below.</p>}</div></div>}
        {selectedPersonal ? <PersonalDetail key={selectedPersonal.key} onOpenDefinition={openDetail} onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(profile, selectedPersonal.ref) }))} option={selectedPersonal}/> : selected ? <DetailView key={selected.key} item={selected} onOpenDefinition={openDetail} personalOverride={selectedPreferred?.ref.kind === 'personal' ? selectedPreferred : undefined} onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(profile, { kind: 'catalog', catalogId: selected.catalog.id, catalogRevisionId: selected.catalog.revisionId, entityId: selected.entity.id }) }))}/> : results.length || personalResults.length ? <div>
          {partition.confirmed.length + personalPartition.confirmed.length === 0 && partition.possible.length + personalPartition.possible.length > 0 && <div className="panel__body"><InlineNotice title="Only possible matches">Unknown or conflicting fields may satisfy the active filters. Review each source before relying on it.</InlineNotice></div>}
          {visiblePersonalResults.map((option) => {
            const possible = personalPartition.possible.includes(option)
            const root = definitionLineageRootRef(profile, option.ref)
            const source = root.kind === 'catalog' ? correctionSource(baseline, root) : undefined
            return <button className="reference-card" key={option.key} onClick={() => openDetail(option.ref)} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }} type="button"><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal</Badge>{option.modAvailability?.requiredMod && <Badge>{modAvailabilityLabel(option.modAvailability)}</Badge>}{possible && <Badge tone="warning">Possible match</Badge>}<Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge>{option.ppCost?.state === 'known' && <Badge tone="info">{option.ppCost.value} PP</Badge>}</div><div className="reference-title">{source ? <WikiSprite catalogId={source.catalog.id} entity={source.entity}/> : <ArtworkPlaceholder entity={option.record}/>}<h3>{option.name}</h3></div>{route.weapon && <SkillSummary entity={option.record}/>}<p>{option.description ?? `${option.sourceLabel} · ${option.stockLabel}`}</p></button>
          })}
          {visibleCatalogResults.map((item) => { const possible = partition.possible.includes(item); const availability = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability; const ref: EntityRef = { kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id }; return <button className="reference-card" key={item.key} onClick={() => openDetail(ref)} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }} type="button"><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{item.catalog.id}</Badge>{availability?.requiredMod && <Badge>{modAvailabilityLabel(availability)}</Badge>}{possible && <Badge tone="warning">Possible match</Badge>}{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">Sources differ</Badge>}{(item.entity.kind === 'passive' || item.entity.kind === 'innate') && <Badge tone={item.ppCost.state === 'known' ? 'info' : item.ppCost.state === 'conflicting' ? 'danger' : 'warning'}>{ppLabel(item)}</Badge>}</div><div className="reference-title"><WikiSprite catalogId={item.catalog.id} entity={item.entity}/><h3>{item.entity.name}</h3></div>{route.weapon && <SkillSummary entity={item.entity}/>}<p>{item.entity.rawDescription ?? `${Object.keys(item.entity.fields).length} normalized fields · ${item.claims.length} source claims`}</p></button> })}
          {totalResults > route.resultLimit && route.resultLimit < ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><Button onClick={() => updateRoute({ resultLimit: Math.min(ROUTE_MAX_RESULT_LIMIT, route.resultLimit + REFERENCE_PAGE_SIZE) }, 'replace')} tone="secondary">Show {Math.min(REFERENCE_PAGE_SIZE, totalResults - route.resultLimit)} more</Button></div>}
          {totalResults > ROUTE_MAX_RESULT_LIMIT && route.resultLimit >= ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><InlineNotice title="Result display limit reached">Refine the name, category, source, type, or PP filters to reach entries beyond the first {ROUTE_MAX_RESULT_LIMIT.toLocaleString()} matches.</InlineNotice></div>}
        </div> : <div className="panel__body"><InlineNotice title="No matches">Unknown fields are kept as possible only when they could satisfy every active filter. Try another name, category, source, kind, or PP bound.</InlineNotice></div>}
      </section>
    </div>}
    {missingEditingRef && <InlineNotice title="Definition override unavailable" tone="warning">The exact definition selected for this override is unavailable. Close this editor address and choose an available definition without changing the original reference. <Button onClick={() => navigation.close()} tone="quiet">Close editor</Button></InlineNotice>}
    {editingRef && editingOption && <DefinitionEditor allowedKinds={[]} baseRef={editingRef} key={entityDefinitionKey(editingRef)} onClose={() => navigation.close()} onSaved={(ref) => navigation.navigate({ ...navigation.route, page: { page: 'reference', view: 'detail', ref }, overlays: [] }, { replace: true })} open routeIndex={0}/>}
    <Sheet description="Collect reviewed preferred personal definitions into a new immutable ruleset revision. Existing build checkpoints keep their exact references, and the active ruleset does not change." onClose={() => navigation.close()} open={promoting} title="Collect into ruleset revision" width="wide"><div className="stack">
      <InlineNotice title="Promotion-ready collection">This creates a new ruleset revision from the selected source. It does not publish a catalog, rewrite old records, or activate the new revision.</InlineNotice>
      <div className="grid-2"><label className="field"><span className="field__label">Source ruleset revision</span><select onChange={(event) => setPromotionRulesetId(event.target.value as RulesetRevisionId)} value={promotionRulesetId}><option value="">Choose ruleset revision</option>{rulesets.map((ruleset) => <option key={ruleset.id} value={ruleset.id}>{ruleset.label} · revision {ruleset.revision}</option>)}</select></label><label className="field"><span className="field__label">New revision label</span><input onChange={(event) => setPromotionLabel(event.target.value)} required value={promotionLabel}/></label></div>
      <fieldset className="definition-collection"><legend>Preferred personal definitions</legend>{preferredPersonalOptions.map((option) => { const checked = promotionRefs.some((ref) => entityDefinitionKey(ref) === option.key); return <label className="check-row" key={option.key}><input checked={checked} onChange={(event) => setPromotionRefs((current) => event.target.checked ? [...current, option.ref] : current.filter((ref) => entityDefinitionKey(ref) !== option.key))} type="checkbox"/><span><strong>{option.name}</strong><small>{option.kind} · {option.sourceLabel}</small></span></label> })}</fieldset>
      {promotionError && <InlineNotice title="Ruleset revision not created" tone="danger">{promotionError} Your selected definitions remain checked.</InlineNotice>}
      <div className="form-actions"><Button disabled={promotionBusy} onClick={() => navigation.close()} tone="quiet">Cancel</Button><Button disabled={promotionBusy || !promotionRulesetId || !promotionRefs.length || !promotionLabel.trim()} icon="check" onClick={() => void promote()}>{promotionBusy ? 'Creating revision...' : 'Create ruleset revision'}</Button></div>
    </div></Sheet>
  </>
}
