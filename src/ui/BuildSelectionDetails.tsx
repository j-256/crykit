import { modPlanningReason } from '../catalog/mods'
import { corroboratedFact } from '../catalog/source-corroboration'
import { bundledModIdentity } from '../domain/bundled-mods'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import { catalogEntity } from '../domain/entity-identities'
import type { CatalogSnapshot, GameSetupRevision, LocalData } from '../domain/types'
import { MoneyText } from './MoneyText'
import { compactKnowledge, decisionFacts, definitionChoiceSourceLabel, hasNameEvidenceOnly, nativeStatSourceNotice, ppCostLabel, selectionSummaryLines } from './build-evidence'
import { definitionKindLabel, type DefinitionOption } from './definitions'
import { LegacyInnateModBadge, ModBadge } from './DefinitionModLabel'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'
import { StatLabel } from './StatRatings'
import { fieldIconKey } from '../catalog/menu-icons'
import { FieldIconSources, GameIcon, hasExternalFieldIcons } from './GameIcon'
import { CatalogArtworkSource, hasExternalCatalogArtwork } from './WikiSprite'
import { Icon } from './icons'
import { Sources } from './Sources'
import { externalSources } from './source-display'
import { CommandAbilities } from './CommandAbilities'

function selectionFacts(option: DefinitionOption, showClassPermissions: boolean) {
  const facts = decisionFacts(option.record).map(fact => ({ ...fact, field: fact.label }))
  if (option.kind !== 'class') return facts.filter(({ label }) => !['passive', 'innate'].includes(option.kind) || !/^(pp|cost)$/i.test(label))
  // A native unknown must not fall back to an older command label
  const commandField = [CLASS_FIELDS.command, CRYSTAL_EDIT_FIELDS.command, 'Command'].find(field => Object.hasOwn(option.record.fields, field)) ?? CLASS_FIELDS.command
  const command = { label: 'Command', field: commandField, value: option.record.fields[commandField] ?? { state: 'unknown' as const } }
  return showClassPermissions ? [command, ...facts.filter(({ label }) => !/^command$/i.test(label))] : [command]
}

function ClassSummaryFact({ label, value, interactiveHelp }: ReturnType<typeof decisionFacts>[number] & { interactiveHelp: boolean }) {
  const text = compactKnowledge(value)
  if (/^command$/i.test(label)) {
    const iconKey = fieldIconKey(label, text)
    return <span className="build-class-facts__command">{iconKey ? <GameIcon iconKey={iconKey}/> : <Icon name="tome"/>}<span>Command: {text}</span></span>
  }
  if (/^(weapons?|armors?)$/i.test(label) && value.state === 'known') {
    const entries = typeof value.value === 'string' ? value.value.split(',').map(part => part.trim()).filter(Boolean) : Array.isArray(value.value) && value.value.every(part => typeof part === 'string') ? value.value as readonly string[] : undefined
    if (entries?.length) return <span className="build-class-facts__types">{entries.map((name, index) => {
      const iconKey = fieldIconKey(label, name)
      return iconKey ? <span aria-label={`${label}: ${name}`} className="build-class-facts__equipment" data-tooltip={name} key={`${name}:${index}`} role="img" tabIndex={interactiveHelp ? 0 : undefined} title={name}><GameIcon iconKey={iconKey}/></span> : <span key={`${name}:${index}`}>{name}</span>
    })}</span>
  }
  return <span>{label}: {text}</span>
}

function SelectionSummary({ option, showPpCost = false }: { option: DefinitionOption; showPpCost?: boolean }) {
  const passive = ['passive', 'innate'].includes(option.kind)
  return <>{showPpCost && passive && <p>{ppCostLabel(option)}</p>}<ul className="build-selection-details__summary">{selectionSummaryLines(option).filter(line => !passive || !/^(cost|pp):/i.test(line)).map(line => <li key={line}><MoneyText>{line}</MoneyText></li>)}</ul></>
}

export function BuildSelectionFacts({ option, interactiveHelp = true, showClassPermissions = true }: { option: DefinitionOption; interactiveHelp?: boolean; showClassPermissions?: boolean }) {
  const facts = selectionFacts(option, showClassPermissions).filter(({ label }) => !/^cost$/i.test(label))
  if (option.kind === 'class' && facts.length) return <span className="build-selection-facts build-class-facts">{[...facts].sort((left, right) => Number(!/^command$/i.test(left.label)) - Number(!/^command$/i.test(right.label))).slice(0, 4).map(fact => <ClassSummaryFact interactiveHelp={interactiveHelp} key={fact.label} {...fact}/>)}</span>
  const lines = selectionSummaryLines(option).filter(line => !/^(cost|pp):/i.test(line))
  return <span className="build-selection-facts"><MoneyText>{lines.length ? lines.slice(0, 4).join(' · ') : hasNameEvidenceOnly(option.record) ? 'Stats and effects unknown' : 'Stats and effects not recorded'}</MoneyText></span>
}

export function BuildSelectionDetails({ option, comparedWith, alternatives = [], catalogs = [], localData, gameSetup, showIdentity = true, showClassPermissions = true }: { option: DefinitionOption; comparedWith?: DefinitionOption; alternatives?: readonly DefinitionOption[]; catalogs?: readonly CatalogSnapshot[]; localData?: LocalData; gameSetup?: GameSetupRevision; showIdentity?: boolean; showClassPermissions?: boolean }) {
  const visibleFacts = (value: DefinitionOption) => selectionFacts(value, showClassPermissions)
  const facts = visibleFacts(option)
  const command = facts.find(fact => /^command$/i.test(fact.label))
  const showAbilities = option.kind === 'class' && localData !== undefined
  const displayedFacts = showAbilities ? facts.filter(fact => !/^command$/i.test(fact.label)) : facts
  const previous = comparedWith && comparedWith.key !== option.key ? visibleFacts(comparedWith) : undefined
  const labels = [...new Set([...facts.map((fact) => fact.label), ...(previous?.map((fact) => fact.label) ?? [])])].sort((left, right) => Number(/^cost$/i.test(left)) - Number(/^cost$/i.test(right)))
  const sourceNotice = nativeStatSourceNotice(option.record)
  // Sub-command evidence covers its command and ability membership, without implying growth or equipment access
  const membershipField = [CLASS_FIELDS.abilities, CRYSTAL_EDIT_FIELDS.abilities].find(field => Object.hasOwn(option.record.fields, field))
  const sourceFields = option.kind === 'class' ? { ...Object.fromEntries(facts.map(({ field, value }) => [field, value])), ...(showAbilities && membershipField ? { [membershipField]: option.record.fields[membershipField]! } : {}) } : option.record.fields
  const values = [...Object.values(sourceFields), ...(option.ppCost ? [option.ppCost] : [])]
  const fieldSources = values.flatMap(value => value.state === 'conflicting' ? value.claims.flatMap(claim => claim.sources) : value.state === 'notApplicable' ? [] : value.sources ?? [])
  const catalog = option.ref.kind === 'catalog' ? catalogs.find(catalog => option.ref.kind === 'catalog' && catalog.id === option.ref.catalogId && catalog.revisionId === option.ref.catalogRevisionId) : undefined
  const entity = catalog && option.ref.kind === 'catalog' ? catalogEntity(catalog, option.ref.entityId) : undefined
  const target = entity && catalog && !bundledModIdentity(option.record) ? { catalog, entity: { ...option.record, id: entity.id } } : undefined
  // Only exact field receipts can quiet citations; imported or changed facts keep their evidence
  const verified = option.kind === 'class' && Object.entries(sourceFields).every(([field, value]) => corroboratedFact(target, field, value))
  const sourceRefs = option.kind === 'class' ? fieldSources.length ? fieldSources : option.record.sources : [...option.record.sources, ...fieldSources]
  const external = verified ? [] : externalSources(sourceRefs)
  const externalArtwork = option.ref.kind === 'catalog' && hasExternalCatalogArtwork(option.ref.catalogId, { ...option.record, id: option.ref.entityId })
  const iconFields = option.kind === 'class' ? Object.fromEntries(facts.map(({ label, value }) => [label, value])) : option.record.fields
  const externalIcons = hasExternalFieldIcons(iconFields)
  const uncertain = alternatives.length > 0 || hasNameEvidenceOnly(option.record) || facts.some(fact => fact.value.state === 'unknown' || fact.value.state === 'conflicting') || option.ppCost?.state === 'unknown' || option.ppCost?.state === 'conflicting'
  const showSources = external.length > 0 || externalArtwork || externalIcons || uncertain || option.ref.kind === 'personal' || option.kind === 'class' && !verified && sourceRefs.length > 0
  const sourceControl = showSources ? <Sources label={`Sources for ${option.name}`}><p>{definitionChoiceSourceLabel(option)}</p>{sourceNotice && <p>{sourceNotice}</p>}{option.kind !== 'class' && option.record.rawDescription && <p><MoneyText>{option.record.rawDescription}</MoneyText></p>}{alternatives.length > 0 && <p className="field__hint">Similar spelling: {alternatives.map((other) => other.name).join(', ')}. These entries have separate IDs. CryKit has not confirmed they are the same item.</p>}<dl className="definition-list">{Object.entries(sourceFields).sort(([left], [right]) => Number(/^cost$/i.test(left)) - Number(/^cost$/i.test(right))).map(([label, value]) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue field={label} showSources value={value}/></dd></div>)}{option.ppCost && <div className="definition-row"><dt>PP cost</dt><dd><KnowledgeValue showSources value={option.ppCost}/></dd></div>}</dl><p className="field__hint">{option.sourceLabel}</p><SourceReferences includeGameExports sources={option.kind === 'class' ? sourceRefs : uncertain ? option.record.sources : externalSources(option.record.sources)}/><FieldIconSources fields={iconFields}/>{option.ref.kind === 'catalog' && <CatalogArtworkSource catalogId={option.ref.catalogId} entity={{ ...option.record, id: option.ref.entityId }}/>}</Sources> : null
  const legacyInnate = option.kind === 'innate' && !option.modAvailability?.requiredMod
  const showPpCost = !previous && ['passive', 'innate'].includes(option.kind)
  return <div className="build-selection-details">
    {(showIdentity || legacyInnate || option.modAvailability?.requiredMod || showPpCost || sourceControl) && <div className="cluster">{showIdentity && <strong>{option.name}</strong>}{legacyInnate && <LegacyInnateModBadge record={option.record}/>}{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} showState={false} state={option.modAvailability.state}/>}<small>{showIdentity ? definitionKindLabel(option.kind) : ''}{showPpCost ? `${showIdentity ? ' · ' : ''}${ppCostLabel(option)}` : ''}</small>{sourceControl}</div>}
    {modPlanningReason(option.modAvailability) && <p className="field__hint">{modPlanningReason(option.modAvailability)}</p>}
    {previous && option.kind !== 'class' ? <table className="build-fact-table"><caption>Catalog facts compared with {comparedWith!.name}</caption><thead><tr><th>{comparedWith!.name}</th><th>{option.name}</th></tr></thead><tbody><tr><td><SelectionSummary option={comparedWith!} showPpCost/></td><td><SelectionSummary option={option} showPpCost/></td></tr></tbody></table> : previous ? <table className="build-fact-table"><caption>Catalog facts compared with {comparedWith!.name}</caption><thead><tr><th>Field</th><th>{comparedWith!.name}</th><th>{option.name}</th></tr></thead><tbody>{labels.map((label) => <tr key={label}><th><StatLabel label={label}/></th><td><KnowledgeValue compact field={label} value={previous.find((fact) => fact.label === label)?.value ?? { state: 'unknown' }}/></td><td><KnowledgeValue compact field={label} value={facts.find((fact) => fact.label === label)?.value ?? { state: 'unknown' }}/></td></tr>)}</tbody></table> : option.kind === 'class' ? <dl className="definition-list">{displayedFacts.map(({ label, value }) => <div className="definition-row" key={label}><dt><StatLabel label={label}/></dt><dd><KnowledgeValue compact field={label} value={value}/></dd></div>)}</dl> : <SelectionSummary option={option}/>}
    {showAbilities && <CommandAbilities catalogs={catalogs} command={command?.value.state === 'known' && typeof command.value.value === 'string' ? command.value.value : 'Command abilities'} gameSetup={gameSetup} localData={localData} option={option}/>}
  </div>
}
