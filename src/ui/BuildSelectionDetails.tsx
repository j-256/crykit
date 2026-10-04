import { modPlanningReason } from '../catalog/mods'
import { MoneyText } from './MoneyText'
import { compactKnowledge, decisionFacts, definitionChoiceSourceLabel, hasNameEvidenceOnly, nativeStatSourceNotice, ppCostLabel, selectionSummaryLines } from './build-evidence'
import { definitionKindLabel, type DefinitionOption } from './definitions'
import { LEARNABLE_INNATE_SKILLS_MOD_LABEL, ModBadge } from './DefinitionModLabel'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'
import { classRatingField } from '../domain/stat-ratings'
import { StatLabel } from './StatRatings'
import { fieldIconKey } from '../catalog/menu-icons'
import { FieldIconSources, GameIcon } from './GameIcon'
import { CatalogArtworkSource } from './WikiSprite'
import { Icon } from './icons'
import { Sources } from './Sources'

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
  const facts = decisionFacts(option.record).filter(({ label }) => !/^cost$/i.test(label) && (showClassPermissions || !/^(weapons?|armors?)$/i.test(label)))
  if (option.kind === 'class' && facts.length) return <span className="build-selection-facts build-class-facts">{[...facts].sort((left, right) => Number(!/^command$/i.test(left.label)) - Number(!/^command$/i.test(right.label))).slice(0, 4).map(fact => <ClassSummaryFact interactiveHelp={interactiveHelp} key={fact.label} {...fact}/>)}</span>
  const lines = selectionSummaryLines(option).filter(line => !/^(cost|pp):/i.test(line))
  return <span className="build-selection-facts"><MoneyText>{lines.length ? lines.slice(0, 4).join(' · ') : hasNameEvidenceOnly(option.record) ? 'Name evidence only; stats and effects unknown' : 'Stats and effects not recorded'}</MoneyText></span>
}

export function BuildSelectionDetails({ option, comparedWith, alternatives = [], showClassRatings = true, showClassPermissions = true }: { option: DefinitionOption; comparedWith?: DefinitionOption; alternatives?: readonly DefinitionOption[]; showClassRatings?: boolean; showClassPermissions?: boolean }) {
  const visibleFacts = (value: DefinitionOption) => decisionFacts(value.record).filter(({ label }) => (!['passive', 'innate'].includes(value.kind) || !/^(pp|cost)$/i.test(label)) && (showClassPermissions || !/^(weapons?|armors?)$/i.test(label)))
  const facts = visibleFacts(option)
  const previous = comparedWith && comparedWith.key !== option.key ? visibleFacts(comparedWith) : undefined
  const labels = [...new Set([...facts.map((fact) => fact.label), ...(previous?.map((fact) => fact.label) ?? [])])].sort((left, right) => Number(/^cost$/i.test(left)) - Number(/^cost$/i.test(right)))
  const [ratingField, ratings] = classRatingField(option.record)
  const sourceNotice = nativeStatSourceNotice(option.record)
  return <div className="build-selection-details">
    <div className="cluster"><strong>{option.name}</strong>{option.kind === 'innate' && <ModBadge name={LEARNABLE_INNATE_SKILLS_MOD_LABEL}/>}{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} showState={false} state={option.modAvailability.state}/>}<small>{definitionKindLabel(option.kind)}{!previous && ['passive', 'innate'].includes(option.kind) ? ` · ${ppCostLabel(option)}` : ''}</small></div>
    {modPlanningReason(option.modAvailability) && <p className="field__hint">{modPlanningReason(option.modAvailability)}</p>}
    {option.kind === 'class' && !showClassPermissions && <p className="field__hint">The sub-command supplies its command. Class equipment permissions are not granted by the sub-command.</p>}
    {option.kind === 'class' && showClassRatings && <div className="build-selection-details__ratings"><h4>Class growth ratings</h4><KnowledgeValue field={ratingField} value={ratings}/><p className="field__hint">Fixed class ratings. Numeric stats also depend on level and growth history.</p></div>}
    {previous && option.kind !== 'class' ? <table className="build-fact-table"><caption>Catalog facts compared with {comparedWith!.name}</caption><thead><tr><th>{comparedWith!.name}</th><th>{option.name}</th></tr></thead><tbody><tr><td><SelectionSummary option={comparedWith!} showPpCost/></td><td><SelectionSummary option={option} showPpCost/></td></tr></tbody></table> : previous ? <table className="build-fact-table"><caption>Catalog facts compared with {comparedWith!.name}</caption><thead><tr><th>Field</th><th>{comparedWith!.name}</th><th>{option.name}</th></tr></thead><tbody>{labels.map((label) => <tr key={label}><th><StatLabel label={label}/></th><td><KnowledgeValue compact field={label} value={previous.find((fact) => fact.label === label)?.value ?? { state: 'unknown' }}/></td><td><KnowledgeValue compact field={label} value={facts.find((fact) => fact.label === label)?.value ?? { state: 'unknown' }}/></td></tr>)}</tbody></table> : option.kind === 'class' ? <dl className="definition-list">{facts.map(({ label, value }) => <div className="definition-row" key={label}><dt><StatLabel label={label}/></dt><dd><KnowledgeValue compact field={label} value={value}/></dd></div>)}</dl> : <SelectionSummary option={option}/>}
    <p className="field__hint">Listed catalog values describe this definition. Build equipment checks and stat estimates show which facts are supported and which effects remain unresolved.</p>
    <Sources label={`Sources for ${option.name}`}><p>{definitionChoiceSourceLabel(option)}</p>{sourceNotice && <p>{sourceNotice}</p>}{option.record.rawDescription && <p><MoneyText>{option.record.rawDescription}</MoneyText></p>}{alternatives.length > 0 && <p className="field__hint">Similar spelling: {alternatives.map((other) => other.name).join(', ')}. These are separate source records; shared identity is unconfirmed. Inventory links are kept separate.</p>}<dl className="definition-list">{Object.entries(option.record.fields).sort(([left], [right]) => Number(/^cost$/i.test(left)) - Number(/^cost$/i.test(right))).map(([label, value]) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue field={label} showSources value={value}/></dd></div>)}{option.ppCost && <div className="definition-row"><dt>PP cost</dt><dd><KnowledgeValue showSources value={option.ppCost}/></dd></div>}</dl><p className="field__hint">{option.sourceLabel}</p><SourceReferences includeGameExports sources={option.record.sources}/><FieldIconSources fields={option.record.fields}/>{option.ref.kind === 'catalog' && <CatalogArtworkSource catalogId={option.ref.catalogId} entity={{ id: option.ref.entityId, kind: option.kind, name: option.name }}/>}</Sources>
  </div>
}
