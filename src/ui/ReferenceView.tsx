import { starterEntitySourceLabel } from '../catalog/provenance'
import { nativeDescription, referenceDescription } from '../catalog/native-description'
import { nativeFieldFacts } from '../catalog/native-field-facts'
import { nativeEquipmentFacts } from '../catalog/native-equipment-facts'
import { nativeReferenceAlternatives } from '../catalog/native-reference-links'
import { nativeMechanic } from '../catalog/native-mechanics'
import { projectAcquisitionGuidance } from '../catalog/acquisition-guidance'
import { descriptionTextMatches, ReferenceDescription, referenceNarrativeDescription } from './ReferenceDescription'
import { ReferenceSourceDetails } from './ReferenceSourceDetails'
import { acquisitionMode, ACQUISITION_MODE_QUERY } from './acquisition-mode'
import { catalogSource } from '../domain/catalog-source'
import { MoneyText } from './MoneyText'
import { ItemAcquisition } from './ItemAcquisition'
import { DefinitionClaimsPanel, DefinitionFactsPanel, DefinitionPlanningPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { modState, modListPriority } from '../domain/mods'
import { modCardIncludesEntry } from '../domain/mod-library'
import { buildModLibraryCards, modCatalogEntry } from './mod-library-data'
import { standingReferenceOptions } from './reference-library'
import { modCatalogTitle } from '../domain/mod-layers'
import { normalizeWeaponType, skillWeaponLabel, skillWeaponRule, UNRESTRICTED_WEAPON_SKILLS_MOD, WEAPON_TYPES } from '../domain/skill-weapons'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { definitionLineageRootRef, entityDefinitionKey, preferredDefinitionRef } from '../domain'
import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, CatalogRef, EntityRef, LocalData, GameSetupRevisionId } from '../domain/types'
import { Badge, BoundedFacetOptions, Button, EmptyState, InlineNotice, ScreenHeader } from './components'
import { WorkspaceMoreActions } from './WorkspaceMoreActions'
import { Icon } from './icons'
import { formatAppError, knowledgeTone } from './model'
import { DefinitionEditor, findDefinitionOption, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { ModBadge } from './DefinitionModLabel'
import { routeWithOverlay, useNavigation, type ReferencePageRoute } from './navigation'
import { Sheet } from './Sheet'
import { KnowledgeValue } from './KnowledgeValue'
import { ArtworkPlaceholder, CatalogArtwork, CatalogArtworkSource, hasExternalCatalogArtwork } from './WikiSprite'
import { FieldIconSources, hasExternalFieldIcons } from './GameIcon'
import { externalSources, sourceDisplay, visibleDefinitionFacts } from './source-display'
import { ClassResearch } from './ClassResearch'
import { nativeDefinitionLabel, nativeDisplayName, nativeRecord, nativeSourceRecord, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import { NativeClassSourceDetails, NativeDefinitionDetails } from './NativeDefinitionDetails'
import { bundledModLabel } from '../domain/bundled-mods'
import { BundledModSourceDetails } from './BundledModSourceDetails'
import { ENEMY_MODE_QUERY, isNativeEnemy, NativeEnemyHero, NativeEnemyStats, useEnemySettings } from './NativeEnemyDetails'
import { resolveReferenceEnemyMode } from '../domain/enemy-difficulty'
import { Dropdown } from './Dropdown'
import { NavigationLink } from './NavigationLink'
import { routeForSearchTarget } from './search-navigation'
import { ReferenceCategoryFilters, ReferenceFacetSection } from './ReferenceFacets'
import { referenceCategoryLabel } from './reference-categories'
import { DEFINITION_KIND_GROUPS, DEFINITION_KIND_LABELS, OPTIONAL_REFERENCE_AUDIENCES, referenceCategoryGroup, referenceFieldFacets, REFERENCE_FACETS, type OptionalReferenceAudience, type ReferenceFacetKey } from './reference-facets'
import {
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

function DetailView({ item, modAvailability, onBack, onOpenDefinition, collectionAction, readOnly = false }: { item: ReferenceSearchItem; modAvailability?: DefinitionOption['modAvailability']; onBack: () => void; onOpenDefinition: (ref: EntityRef) => void; collectionAction: ReactNode; readOnly?: boolean }) {
  const navigation = useNavigation()
  const target: CatalogRef = { kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id }
  const mechanic = nativeMechanic(item.entity)
  const nativeLabel = nativeDefinitionLabel(item.entity) ?? bundledModLabel(item.entity) ?? mechanic?.scope
  const enemy = isNativeEnemy(item.entity)
  const settings = useEnemySettings(item.catalog, enemy ? item.entity : undefined)
  const record = nativeSourceRecord(item.entity)
  const sourceLabel = starterEntitySourceLabel(item.entity)
  const description = nativeDescription(item.entity)
  const narrativeDescription = referenceNarrativeDescription(item.entity)
  const mode = acquisitionMode(item.entity, navigation.route.query[ACQUISITION_MODE_QUERY]?.[0])
  const guidance = projectAcquisitionGuidance(item.catalog, item.entity, mode?.native ?? 'unresolved')
  const nativeFacts = nativeFieldFacts(item.catalog, item.entity)
  const equipment = nativeEquipmentFacts(item.catalog, item.entity)
  const visibleFacts = [...new Map([...visibleDefinitionFacts(item.entity).map(([field, value]) => [field, nativeFacts.find(fact => fact.field === field)?.value ?? value] as const), ...equipment?.facts.map(fact => [fact.field, fact.value] as const) ?? []])]
  const archivedFacts = visibleFacts.filter(([field, value]) => field === 'Description' && value.state === 'known' && typeof value.value === 'string' && (descriptionTextMatches(value.value, narrativeDescription) || descriptionTextMatches(value.value, referenceDescription(item.entity)) || description?.complete && value.value === item.entity.rawDescription))
  const facts = visibleFacts.filter(([field]) => !nativeFacts.some(fact => fact.field === field && fact.redundantWith) && !guidance.replacedFields.includes(field) && !archivedFacts.some(([archived]) => archived === field) && (!equipment?.archivedFields.some(([archived]) => archived === field) || equipment.facts.some(fact => fact.field === field)) && !mechanic?.replacedFields.includes(field))
  const verifiedNativeFacts = [...nativeFacts, ...equipment?.facts ?? []]
  const sourcesDiffer = facts.some(([, value]) => value.state === 'conflicting') || guidance.disagreements.length > 0
  const uncertain = sourcesDiffer || facts.some(([, value]) => value.state === 'unknown') || Boolean(description && !description.complete)
  const relatedSources = nativeReferenceAlternatives(item.catalog, item.entity.id).flatMap(link => externalSources(item.catalog.entities[link.sourceId]?.sources ?? []))
  const sourceRefs = [...new Map([...item.entity.sources, ...relatedSources].map(source => [JSON.stringify(source), source])).values()]
  const actions = <><a className="button button--quiet" href="https://github.com/j-256/crykit/issues" rel="noreferrer" target="_blank">Report a data issue</a>{collectionAction}</>
  const sourcePanel = <DefinitionSourcesPanel key={referenceDefinitionKey(item)} label={`Sources for ${nativeDisplayName(item.entity)}`} sources={sourceRefs} uncertain={uncertain} hasExternalContent={hasExternalCatalogArtwork(item.catalog.id, item.entity) || hasExternalFieldIcons(item.entity.fields)}>{uncertain && <NativeClassSourceDetails catalog={item.catalog} entity={item.entity} onOpenDefinition={onOpenDefinition}/>}<BundledModSourceDetails entity={item.entity}/><ReferenceSourceDetails catalog={item.catalog} entity={item.entity} guidance={guidance} nativeFacts={nativeFacts} archivedFacts={archivedFacts} archivedEquipmentFields={equipment?.archivedFields} onOpenDefinition={onOpenDefinition}/><CatalogArtworkSource catalogId={item.catalog.id} entity={item.entity}/><FieldIconSources fields={item.entity.fields}/>{item.claims.length > 0 && <DefinitionClaimsPanel claims={item.claims}/>}</DefinitionSourcesPanel>
  return <div className={`panel__body stack reference-detail${enemy ? ' reference-detail--enemy' : ''}`}>
    <div className="reference-detail__toolbar"><div className="reference-detail__navigation"><Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button>{sourcePanel}</div>{enemy && !readOnly ? <ReferenceActions>{actions}<p className="definition-scope">Include the entry, game version, and source evidence in your report.</p></ReferenceActions> : <div className="cluster">{actions}</div>}</div>
    {enemy ? <NativeEnemyHero catalog={item.catalog} settingsControl={settings.control} entity={item.entity} preview={settings.preview} meta={modAvailability?.requiredMod && <ModBadge name={modAvailability.requiredMod} state={modAvailability.state}/>} name={<h2>{nativeDisplayName(item.entity)}</h2>} description={(record?.Description || item.entity.legacy && nativeRecord(item.entity.legacy) && item.entity.legacy.nativeDescriptionSupplemental === true) ? <ReferenceDescription catalog={item.catalog} entity={item.entity}/> : undefined}/> : <><div><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{nativeLabel ?? sourceLabel ?? modCatalogTitle(item.catalog)}</Badge>{modAvailability?.requiredMod && <ModBadge name={modAvailability.requiredMod} state={modAvailability.state}/>}{!nativeLabel && !sourceLabel && <Badge tone={knowledgeTone(item.catalog.applicability)}>{item.catalog.applicability.state === 'known' ? item.catalog.applicability.value : 'Applicability unknown'}</Badge>}{sourcesDiffer && <Badge tone="warning">Sources differ</Badge>}</div><div className="reference-title"><CatalogArtwork catalogId={item.catalog.id} detailed entity={item.entity}/><h2>{nativeDisplayName(item.entity)}</h2></div><ReferenceDescription catalog={item.catalog} entity={item.entity}/>{item.entity.aliases.length > 0 && <small>Aliases: {item.entity.aliases.join(', ')}</small>}</div></>}
    {item.entity.kind === 'item' && <ItemAcquisition key={`acquisition:${referenceDefinitionKey(item)}`} catalog={item.catalog} entity={item.entity} onOpenDefinition={onOpenDefinition}/>}
    {enemy && <NativeEnemyStats entity={item.entity} preview={settings.preview}/>}
    <NativeDefinitionDetails catalog={item.catalog} enemyMode={settings.nativeMode} entity={item.entity} onOpenDefinition={onOpenDefinition} technicalDetails={enemy ? <><DefinitionFactsPanel moneyFormat="integer" corroboration={{ catalog: item.catalog, entity: item.entity }} verifiedNativeFacts={nativeFacts} facts={facts}/><DefinitionPlanningPanel definition={item.entity} verifiedNativeFacts={nativeFacts}/></> : undefined}/>
    <ClassResearch catalog={item.catalog} definitionRef={target} entity={item.entity} key={referenceDefinitionKey(item)}/>
    {!enemy && <div className="stack definition-detail-sections">
      <DefinitionFactsPanel corroboration={{ catalog: item.catalog, entity: item.entity }} verifiedNativeFacts={verifiedNativeFacts} facts={facts}/>
    </div>}
    {!enemy && <DefinitionPlanningPanel definition={item.entity} verifiedNativeFacts={nativeFacts}/>}
  </div>
}

function PersonalDetail({ option, onBack, onEdit, onOpenDefinition, collectionAction, readOnly = false }: { option: DefinitionOption; onBack: () => void; onEdit: () => void; onOpenDefinition: (ref: EntityRef) => void; collectionAction: ReactNode; readOnly?: boolean }) {
  const { localData, catalogs: baseline } = useDefinitionLibrary()
  const definition = option.record
  const root = definitionLineageRootRef(localData, option.ref)
  const source = root.kind === 'catalog' ? catalogSource(baseline, root) : undefined
  const primarySourceId = source && nativeDefinitionLabel(source.entity) ? definition.sources.find(entry => entry.sourceId.startsWith(NATIVE_SOURCE_PREFIX))?.sourceId : undefined
  const facts = visibleDefinitionFacts(definition)
  const nativeEntity = source ? { ...source.entity, name: option.name, rawDescription: option.description, aliases: definition.aliases, fields: definition.fields, sources: definition.sources } : undefined
  const enemy = nativeEntity && isNativeEnemy(nativeEntity) ? nativeEntity : undefined
  const settings = useEnemySettings(source?.catalog, enemy)
  const history = <details className="definition-disclosure"><summary>Definition history</summary><dl className="definition-list"><div className="definition-row"><dt>Revision</dt><dd>{'revision' in definition ? definition.revision : 'Catalog base'}</dd></div>{'baseRef' in definition && definition.baseRef && <div className="definition-row"><dt>Based on</dt><dd><Button onClick={() => onOpenDefinition(definition.baseRef!)} tone="quiet">View source definition</Button></dd></div>}{'previousRevision' in definition && definition.previousRevision && <div className="definition-row"><dt>Previous revision</dt><dd><Button onClick={() => onOpenDefinition(definition.previousRevision!)} tone="quiet">View previous revision</Button></dd></div>}<div className="definition-row"><dt>Exact identity</dt><dd>{option.key}</dd></div></dl></details>
  const uncertain = facts.some(([, value]) => value.state === 'unknown' || value.state === 'conflicting')
  const sourcePanel = <DefinitionSourcesPanel key={option.key} label={`Sources for ${option.name}`} sources={definition.sources} uncertain={uncertain} hasExternalContent={Boolean(source && hasExternalCatalogArtwork(source.catalog.id, source.entity)) || hasExternalFieldIcons(definition.fields)}>{uncertain && source && nativeEntity && <NativeClassSourceDetails catalog={source.catalog} entity={nativeEntity} onOpenDefinition={onOpenDefinition}/>}{source && <CatalogArtworkSource catalogId={source.catalog.id} entity={source.entity}/>}<FieldIconSources fields={definition.fields}/>{(source?.claims.length ?? 0) > 0 && <DefinitionClaimsPanel claims={source?.claims ?? []}/>}</DefinitionSourcesPanel>
  return <div className={`panel__body stack reference-detail${enemy ? ' reference-detail--enemy' : ''}`}>
    <div className="reference-detail__toolbar"><div className="reference-detail__navigation"><Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button>{sourcePanel}</div><div className="cluster">{!readOnly && root.kind === 'personal' && <Button icon="edit" onClick={onEdit} tone="secondary">{option.preferred ? 'Edit custom definition' : 'Edit latest custom definition'}</Button>}{collectionAction}</div></div>
    {enemy && source ? <NativeEnemyHero catalog={source.catalog} settingsControl={settings.control} entity={enemy} preview={settings.preview} name={<h2>{option.name}</h2>} meta={<><Badge>Saved catalog version</Badge><Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>}</>} description={option.description !== source.entity.rawDescription || nativeSourceRecord(enemy)?.Description || nativeRecord(enemy.legacy) && enemy.legacy.nativeDescriptionSupplemental === true ? <p><MoneyText>{option.description ?? 'No description supplied.'}</MoneyText></p> : undefined}/> : <><div><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal definition</Badge>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>}<Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge></div><div className="reference-title">{source ? <CatalogArtwork catalogId={source.catalog.id} detailed entity={source.entity}/> : <ArtworkPlaceholder detailed entity={definition}/>}<h2>{option.name}</h2></div><p><MoneyText>{option.description ?? 'No raw description supplied.'}</MoneyText></p>{option.aliases.length > 0 && <small>Aliases: {option.aliases.join(', ')}</small>}</div></>}
    <p className="definition-scope">{root.kind === 'catalog' ? 'Saved catalog version. This record is read-only; existing Builds and observations keep this exact version.' : 'Custom definition shared across your Playthroughs. Edits save a new revision; existing records keep their saved version.'}</p>
    {history}
    {source && nativeEntity && definition.kind === 'item' && <ItemAcquisition key={`acquisition:${entityDefinitionKey(option.ref)}`} catalog={source.catalog} entity={nativeEntity} onOpenDefinition={onOpenDefinition}/>}
    {enemy && <NativeEnemyStats entity={enemy} preview={settings.preview}/>}
    {source && primarySourceId && <NativeDefinitionDetails catalog={source.catalog} enemyMode={settings.nativeMode} entity={nativeEntity!} onOpenDefinition={onOpenDefinition} technicalDetails={enemy ? <><DefinitionFactsPanel moneyFormat="integer" facts={facts}/><DefinitionPlanningPanel definition={definition}/></> : undefined}/>}
    <ClassResearch catalog={source?.catalog} definitionRef={option.ref} entity={definition} key={option.key} sourceEntity={source?.entity}/>
    {!enemy && <div className="stack definition-detail-sections"><DefinitionFactsPanel facts={facts}/></div>}
    {!enemy && <DefinitionPlanningPanel definition={definition}/>}
  </div>
}

function mergeFacetOptions(base: readonly { readonly value: string; readonly count: number }[], additions: readonly string[]) {
  const counts = new Map(base.map((option) => [option.value, option.count]))
  for (const value of additions) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value))
}

export interface ReferenceViewProps {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onOpenData: () => void
  readonly onPromoteDefinitions: (sourceGameSetupRevisionId: GameSetupRevisionId, definitionRefs: readonly EntityRef[], label: string) => Promise<void>
}

export function ReferenceView({ localData, catalogs, onOpenData, onPromoteDefinitions, temporary = false, temporaryAction, associationCatalogs = catalogs }: ReferenceViewProps & { readonly temporary?: boolean; readonly temporaryAction?: ReactNode; readonly associationCatalogs?: readonly CatalogSnapshot[] }) {
  const navigation = useNavigation()
  const baseline = catalogs
  const { options } = useDefinitionLibrary()
  const route = readReferenceRouteState()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [promotionRefs, setPromotionRefs] = useState<readonly EntityRef[]>([])
  const [promotionGameSetupId, setPromotionGameSetupId] = useState<GameSetupRevisionId | ''>(localData.planningGameSetupRevisionId ?? '')
  const [promotionLabel, setPromotionLabel] = useState('Reviewed personal definitions')
  const [promotionBusy, setPromotionBusy] = useState(false)
  const [promotionError, setPromotionError] = useState<string>()
  const items = useMemo(() => buildReferenceSearchItems(catalogs), [catalogs])
  const optionsByKey = useMemo(() => new Map(options.map(option => [option.key, option])), [options])
  const modCards = useMemo(() => buildModLibraryCards(associationCatalogs, options, localData), [associationCatalogs, options, localData])
  const scopedMod = route.libraryMod ? modCards.find(card => card.id === route.libraryMod) : undefined
  const scopedOptions = useMemo(() => route.libraryMod ? options.filter(option => option.preferred && scopedMod && modCardIncludesEntry(scopedMod, modCatalogEntry(option, associationCatalogs, localData))) : standingReferenceOptions(options, baseline, localData), [options, baseline, associationCatalogs, localData, route.libraryMod, scopedMod])
  const scopedKeys = useMemo(() => new Set(scopedOptions.map(option => option.key)), [scopedOptions])
  const allSearchableItems = useMemo(() => items.filter(item => scopedKeys.has(referenceDefinitionKey(item))).map(item => {
    const requiredMod = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability?.requiredMod
    return requiredMod ? { ...item, projection: { ...item.projection, ...referenceFieldFacets(item.entity, item.claims, requiredMod) } } : item
  }), [scopedKeys, items, optionsByKey])
  const audienceOptions = useMemo(() => OPTIONAL_REFERENCE_AUDIENCES.map(audience => ({ ...audience, count: allSearchableItems.filter(item => item.audience === audience.value).length })).filter(audience => audience.count > 0), [allSearchableItems])
  const searchableItems = useMemo(() => allSearchableItems.filter(item => item.audience === 'default' || route.audiences.includes(item.audience)), [allSearchableItems, route.audiences])
  const hiddenAudienceItems = useMemo(() => allSearchableItems.filter(item => item.audience !== 'default' && !route.audiences.includes(item.audience)), [allSearchableItems, route.audiences])
  const availablePersonalOptions = useMemo(() => scopedOptions.filter(option => option.ref.kind === 'personal'), [scopedOptions])
  const personalOptions = useMemo(() => options.filter((option) => option.ref.kind === 'personal'), [options])
  const preferredPersonalOptions = useMemo(() => personalOptions.filter((option) => option.preferred), [personalOptions])
  const facetItems = useMemo(() => searchableItems.filter(item => !route.kinds.length || route.kinds.includes(item.entity.kind)), [searchableItems, route.kinds])
  const facetPersonalOptions = useMemo(() => availablePersonalOptions.filter(option => !route.kinds.length || route.kinds.includes(option.kind)), [availablePersonalOptions, route.kinds])
  const kindOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'kind'), availablePersonalOptions.map((option) => option.kind)), [searchableItems, availablePersonalOptions])
  const categoryOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(facetItems, 'category'), facetPersonalOptions.flatMap(personalDefinitionCategoryValues)).sort((left, right) => referenceCategoryLabel(left.value).localeCompare(referenceCategoryLabel(right.value))), [facetItems, facetPersonalOptions])
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
  const visibleResults = useMemo(() => [
    ...personalResults.map(option => ({ kind: 'personal' as const, option, availability: option.modAvailability })),
    ...results.map(item => ({ kind: 'catalog' as const, item, availability: optionsByKey.get(referenceDefinitionKey(item))?.modAvailability })),
  ].sort((a, b) => modListPriority(a.availability) - modListPriority(b.availability)).slice(0, route.resultLimit), [personalResults, results, optionsByKey, route.resultLimit])
  const totalResults = personalResults.length + results.length
  const page = navigation.route.page.page === 'reference' ? navigation.route.page : { page: 'reference', view: 'list' } as const
  const selectedRef = page.view === 'detail' ? page.ref : undefined
  const selectionInScope = !temporary || !selectedRef || scopedKeys.has(entityDefinitionKey(selectedRef))
  const selectedSource = selectionInScope && selectedRef?.kind === 'catalog' ? items.find((item) => item.catalog.id === selectedRef.catalogId && item.catalog.revisionId === selectedRef.catalogRevisionId && item.entity.id === selectedRef.entityId) : undefined
  const selectedMode = resolveReferenceEnemyMode(selectedSource?.catalog, selectedSource?.entity, navigation.route.query[ENEMY_MODE_QUERY]?.[0])
  const selected = selectedMode?.entityId && selectedMode.entityId !== selectedSource?.entity.id ? items.find(item => item.catalog === selectedSource?.catalog && item.entity.id === selectedMode.entityId && (!temporary || scopedKeys.has(referenceDefinitionKey(item)))) : selectedSource
  const selectedDefinitionRef: EntityRef | undefined = selected ? { kind: 'catalog', catalogId: selected.catalog.id, catalogRevisionId: selected.catalog.revisionId, entityId: selected.entity.id } : selectedRef
  const selectedPersonal = selectionInScope && selectedRef?.kind === 'personal' ? findDefinitionOption(options, selectedRef) : undefined
  const selectedAvailability = selectedDefinitionRef ? optionsByKey.get(entityDefinitionKey(selectedDefinitionRef))?.modAvailability : undefined
  useEffect(() => {
    if (selectedRef?.kind === 'catalog' && selected && selectedRef.entityId !== selected.entity.id) navigation.navigate({ ...navigation.route, page: { page: 'reference', view: 'detail', ref: { ...selectedRef, entityId: selected.entity.id } } }, { replace: true })
  }, [navigation, selected, selectedRef])
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
    ...(route.libraryMod ? [{ key: 'libraryMod', label: `Mod: ${scopedMod?.title ?? 'Unavailable mod'}`, clear: { libraryMod: undefined } }] : []),
    ...(route.query ? [{ key: 'query', label: `Search: ${route.query}`, clear: { query: '' } }] : []),
    ...route.kinds.map(kind => ({ key: `kind:${kind}`, label: DEFINITION_KIND_LABELS[kind], clear: { kinds: route.kinds.filter(value => value !== kind) } })),
    ...route.categories.map(category => ({ key: `category:${category}`, label: referenceCategoryLabel(category), clear: { categories: route.categories.filter(value => value !== category) } })),
    ...route.audiences.map(audience => ({ key: `audience:${audience}`, label: `Include ${OPTIONAL_REFERENCE_AUDIENCES.find(option => option.value === audience)!.label}`, clear: { audiences: route.audiences.filter(value => value !== audience) } })),
    ...REFERENCE_FACETS.flatMap(facet => (route[facet.key] ?? []).map(value => ({ key: `${facet.key}:${value}`, label: `${facet.label}: ${value}`, clear: { [facet.key]: route[facet.key]?.filter(entry => entry !== value) } }))),
    ...route.sources.map(source => ({ key: `source:${source}`, label: `Source: ${sourceDisplay(source).label}`, clear: { sources: route.sources.filter(value => value !== source) } })),
    ...(route.weapon ? [{ key: 'weapon', label: `Weapon skills: ${route.weapon}`, clear: { weapon: undefined, includeUncertainSkills: undefined } }] : []),
    ...(route.includeUncertainSkills ? [{ key: 'uncertainSkills', label: 'Uncertain weapon skills', clear: { includeUncertainSkills: undefined } }] : []),
    ...(route.ppMin === undefined ? [] : [{ key: 'ppMin', label: `PP minimum: ${route.ppMin}`, clear: { ppMin: undefined } }]),
    ...(route.ppMax === undefined ? [] : [{ key: 'ppMax', label: `PP maximum: ${route.ppMax}`, clear: { ppMax: undefined } }]),
  ]

  const clearFilters = () => updateFilter({ ...DEFAULT_REFERENCE_ROUTE_STATE, ...Object.fromEntries(REFERENCE_FACETS.map(facet => [facet.key, []])), libraryMod: temporary && scopedMod ? route.libraryMod : undefined, weapon: undefined, includeUncertainSkills: undefined, ppMin: undefined, ppMax: undefined }, 'push')

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

  const hiddenMatchNotice = route.query && hiddenAudienceMatches.length > 0 ? <InlineNotice title={`${hiddenResults.length} additional ${hiddenResults.length === 1 ? 'match is' : 'matches are'} hidden`} tone="warning"><p>The default Reference omits technical records and alternative sources. Include a matching category to see these results.</p><div className="cluster">{hiddenAudienceMatches.map(audience => <Button key={audience.value} onClick={() => updateFilter({ audiences: [...route.audiences, audience.value] }, 'push')} tone="quiet">Show {audience.label}</Button>)}</div></InlineNotice> : null

  const collectionAction = temporary ? null : <Button disabled={!preferredPersonalOptions.length || !gameSetups.length} icon="layers" onClick={() => { setPromotionRefs(preferredPersonalOptions.map(option => option.ref)); navigate({ page: 'reference', view: 'promote' }) }} tone="secondary">Collect into Game Setup revision</Button>

  return <>
    <ScreenHeader breadcrumb={selectedRef ? <Button icon="arrow-left" onClick={() => navigate({ page: 'reference', view: 'list' })} tone="quiet">All Reference</Button> : undefined} actions={selectedRef || temporary ? undefined : <><Button icon="upload" onClick={onOpenData} tone="secondary">Import reference</Button><WorkspaceMoreActions title="Reference actions">{collectionAction}</WorkspaceMoreActions></>} description={temporary ? `Search only ${scopedMod?.title ?? 'this mod'}'s catalog.` : 'Browse vanilla and Switch mod pack contents, plus mods you add to Reference.'} eyebrow="Game reference" title="Reference"/>
    {temporary && <InlineNotice title="Temporary mod catalog"><p>Browsing this catalog does not add it to Reference or change any Game Setup.</p><div className="cluster">{temporaryAction}<Button onClick={() => navigation.navigate({ page: { page: 'reference', view: 'list' }, overlays: [], query: {} })} tone="secondary">Return to Reference</Button></div></InlineNotice>}
    {!selectedRef && activeFilters.length > 0 && <div aria-label="Active reference filters" className="reference-active-filters" role="group">{activeFilters.map(filter => <button aria-label={`Remove ${filter.label} filter`} className="filter-chip" key={filter.key} onClick={() => updateFilter(filter.clear, 'push')} title={filter.label} type="button"><span>{filter.label}</span><Icon name="close"/></button>)}<Button onClick={clearFilters} tone="quiet">Clear all filters</Button></div>}
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
            <p className="settings-section__intro">Game and planning records are always included. Add technical records or alternative sources when you need it.</p>
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
        {selectedPersonal ? <PersonalDetail readOnly={temporary} collectionAction={collectionAction} key={selectedPersonal.key} onOpenDefinition={openDetail} onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(localData, selectedPersonal.ref) }))} option={selectedPersonal}/> : selected ? <DetailView readOnly={temporary} collectionAction={collectionAction} key={selected.key} item={selected} modAvailability={selectedAvailability} onOpenDefinition={openDetail} onBack={() => navigation.close()}/> : results.length || personalResults.length ? <div>
          {hiddenMatchNotice && <div className="panel__body">{hiddenMatchNotice}</div>}
          {partition.confirmed.length + personalPartition.confirmed.length === 0 && partition.possible.length + personalPartition.possible.length > 0 && <div className="panel__body"><InlineNotice title="Only possible matches">Unknown or conflicting fields may satisfy the active filters. Review each source before relying on it.</InlineNotice></div>}
          {visibleResults.map(result => {
            if (result.kind === 'personal') {
              const option = result.option
              const possible = personalPartition.possible.includes(option)
              const root = definitionLineageRootRef(localData, option.ref)
              const source = root.kind === 'catalog' ? catalogSource(baseline, root) : undefined
              return <NavigationLink className="reference-card" data-mod-state={option.modAvailability?.requiredMod ? option.modAvailability.state : undefined} key={option.key} route={{ ...routeForSearchTarget({ kind: 'definition', ref: option.ref }), query: navigation.route.query }} onNavigate={() => openDetail(option.ref)} style={{ width: '100%', borderInline: 0, borderTop: 0, textAlign: 'left' }}><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal</Badge>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>} {possible && <Badge tone="warning">Possible match</Badge>}<Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge>{option.ppCost?.state === 'known' && <Badge tone="info">{option.ppCost.value} PP</Badge>}</div><div className="reference-title">{source ? <CatalogArtwork catalogId={source.catalog.id} entity={source.entity}/> : <ArtworkPlaceholder entity={option.record}/>}<h3>{option.name}</h3></div>{route.weapon && <SkillSummary entity={option.record}/>}<p><MoneyText>{option.description ?? `${option.sourceLabel} · ${option.stockLabel}`}</MoneyText></p></NavigationLink>
            }
            const item = result.item
            const nativeLabel = nativeDefinitionLabel(item.entity) ?? bundledModLabel(item.entity) ?? nativeMechanic(item.entity)?.scope; const possible = partition.possible.includes(item); const availability = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability; const ref: EntityRef = { kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id }; return <NavigationLink className="reference-card" data-mod-state={availability?.requiredMod ? availability.state : undefined} key={item.key} route={{ ...routeForSearchTarget({ kind: 'definition', ref }), query: navigation.route.query }} onNavigate={() => openDetail(ref)} style={{ width: '100%', borderInline: 0, borderTop: 0, textAlign: 'left' }}><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{nativeLabel ?? starterEntitySourceLabel(item.entity) ?? modCatalogTitle(item.catalog)}</Badge>{availability?.requiredMod && <ModBadge name={availability.requiredMod} state={availability.state}/>} {possible && <Badge tone="warning">Possible match</Badge>}{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">Sources differ</Badge>}{(item.entity.kind === 'passive' || item.entity.kind === 'innate') && <Badge tone={item.ppCost.state === 'known' ? 'info' : item.ppCost.state === 'conflicting' ? 'danger' : 'warning'}>{ppLabel(item)}</Badge>}</div><div className="reference-title"><CatalogArtwork catalogId={item.catalog.id} entity={item.entity}/><h3>{nativeDisplayName(item.entity)}</h3></div>{route.weapon && <SkillSummary entity={item.entity}/>}<ReferenceDescription compact catalog={item.catalog} entity={item.entity} fallback={temporary ? 'No description supplied.' : `${Object.keys(item.entity.fields).length} normalized fields · ${item.claims.length} source claims`}/></NavigationLink> })}
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
