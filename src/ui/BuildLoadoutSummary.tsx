import { entityDefinitionKey, logicalEntityKey, validateBuildContent } from '../domain'
import { definitionModAvailability, modAvailabilityLabel } from '../catalog/mods'
import { passivePointCost } from '../domain/mechanics-facts'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import type { BuildPpValidity } from '../domain/build-validity'
import type { BuildRevisionContent, CatalogSnapshot, EntityRef, Profile, RulesetRevision, SlotDefinition } from '../domain/types'
import { DefinitionModLabel } from './DefinitionModLabel'
import { DefinitionArtwork } from './GameIcon'
import { compactKnowledge, decisionFacts } from './build-evidence'
import { Icon, type IconName } from './icons'
import { entityName, resolveEntity } from './model'

const EMPTY_BUILD_CONTENT: BuildRevisionContent = Object.freeze({
  primaryClass: null,
  secondaryClass: null,
  equipment: {},
  passives: [],
  contextAssumptions: [],
})

function equipmentIcon(role: SlotDefinition['equipmentRole']): IconName {
  if (role === 'mainHand') return 'sword'
  if (role === 'offHand') return 'shield'
  if (role === 'head') return 'character'
  if (role === 'body') return 'chest'
  return 'crystal'
}

function SummarySelection({ label, value, profile, catalogs, ruleset, empty, compact = false, hideLabel = false, emptyIcon }: { label: string; value?: EntityRef | null; profile: Profile; catalogs: readonly CatalogSnapshot[]; ruleset?: RulesetRevision; empty: string; compact?: boolean; hideLabel?: boolean; emptyIcon?: IconName }) {
  const name = value ? entityName(profile, catalogs, value) : empty
  const definition = value ? resolveEntity(profile, catalogs, value) : undefined
  const facts = definition ? [
    ...Object.entries(definition.listedContributions ?? {}).map(([factLabel, fact]) => fact.state === 'known' ? `${factLabel}: ${fact.value.value > 0 ? '+' : ''}${fact.value.value} ${fact.value.unit}${fact.value.condition ? ` when ${fact.value.condition}` : ''}` : `${factLabel}: ${compactKnowledge(fact)}`),
    ...decisionFacts(definition).map(fact => `${fact.label}: ${compactKnowledge(fact.value)}`),
  ].sort((left, right) => Number(!/attack|defense|resistance/i.test(left)) - Number(!/attack|defense|resistance/i.test(right))).slice(0, 5) : []
  const availability = value ? modAvailabilityLabel(definitionModAvailability(profile, value, ruleset)) : undefined
  const tooltip = [`${label}: ${name}`, ...facts, ...(availability ? [availability] : [])].join('\n')
  return <span aria-label={`${label}: ${name}`} className="build-card__selection" data-compact={compact || undefined} data-empty={!value || undefined} data-tooltip={tooltip} title={tooltip}>
    {value ? <DefinitionArtwork catalogs={catalogs} profile={profile} value={value}/> : emptyIcon ? <Icon className="build-card__selection-empty-icon" name={emptyIcon}/> : <span aria-hidden="true" className="build-card__selection-placeholder">?</span>}
    {compact ? <span className="sr-only">{name}</span> : <span><small className={hideLabel ? 'sr-only' : undefined}>{label}</small><span className="build-card__selection-name">{name}</span><DefinitionModLabel profile={profile} ruleset={ruleset} value={value}/></span>}
  </span>
}

export function buildPpSummary(pp: BuildPpValidity): string {
  const subtotal = `${pp.knownSubtotal}${pp.unresolvedCosts ? ` + ${pp.unresolvedCosts} unresolved` : ''}`
  if (pp.limit.state === 'known') return `${subtotal} of ${pp.limit.value} PP used across passives`
  if (pp.limit.state === 'conflicting') return `${subtotal} PP used / conflicting shared limit`
  if (pp.limit.state === 'notApplicable') return `${subtotal} PP used / no shared limit applies`
  return `${subtotal} PP used / unknown shared limit`
}

export function PassiveCapacityMeter({ pp, announce = false }: { pp: BuildPpValidity; announce?: boolean }) {
  const limit = pp.limit.state === 'known' ? Math.max(0, pp.limit.value) : undefined
  const summary = buildPpSummary(pp)
  const compactSummary = limit === undefined ? `${pp.knownSubtotal}${pp.unresolvedCosts ? ` + ${pp.unresolvedCosts}?` : ''} PP` : `${pp.knownSubtotal}${pp.unresolvedCosts ? ` + ${pp.unresolvedCosts}?` : ''} / ${limit} PP`
  return <span aria-label={announce ? 'Build PP summary' : `Passive capacity: ${summary}`} className="passive-capacity" role={announce ? 'status' : 'img'}>
    {limit !== undefined && <span aria-hidden="true" className="passive-capacity__crystals">{Array.from({ length: limit }, (_, index) => <Icon className={index < pp.knownSubtotal ? 'is-lit' : undefined} key={index} name="crystal"/>)}</span>}
    <small aria-hidden="true">{compactSummary}</small>
  </span>
}

export function BuildLoadoutSummary({ content = EMPTY_BUILD_CONTENT, profile, catalogs, ruleset, announcePp = false }: { content?: BuildRevisionContent; profile: Profile; catalogs: readonly CatalogSnapshot[]; ruleset?: RulesetRevision; announcePp?: boolean }) {
  const slots = [...(ruleset?.slots.length ? ruleset.slots : SUGGESTED_BUILD_SLOTS)].sort((left, right) => left.order - right.order)
  const report = validateBuildContent(content, ruleset, slots, ref => resolveEntity(profile, catalogs, ref), ref => logicalEntityKey(profile, ref))
  const invalidIssues = report.issues.filter(issue => issue.status === 'invalid').length
  return <span className="build-loadout-summary" data-validity={report.status}>
    {report.status === 'invalid' && <span className="build-loadout-summary__warning"><Icon name="warning"/><strong>Needs changes</strong><small>{invalidIssues} known {invalidIssues === 1 ? 'issue' : 'issues'}</small></span>}
    <span className="build-card__classes">
      <SummarySelection catalogs={catalogs} empty="No class selected" label="Class" profile={profile} ruleset={ruleset} value={content.primaryClass}/>
      <SummarySelection catalogs={catalogs} empty="No sub-command" label="Sub-command" profile={profile} ruleset={ruleset} value={content.secondaryClass}/>
    </span>
    <span className="build-card__summary-group">
      <span className="build-card__summary-label" title="Equipment"><Icon name="sword"/><span className="sr-only">Equipment</span></span>
      <span aria-label="Equipment" className="build-card__equipment">{slots.map(slot => <SummarySelection catalogs={catalogs} compact empty="Empty" emptyIcon={equipmentIcon(slot.equipmentRole)} key={slot.id} label={slot.label} profile={profile} ruleset={ruleset} value={content.equipment[slot.id]?.ref}/>)}</span>
    </span>
    <span className="build-card__summary-group">
      <span className="build-card__summary-label" title="Passives"><Icon name="crystal"/><span className="sr-only">Passives</span></span>
      <PassiveCapacityMeter announce={announcePp} pp={report.pp}/>
      {content.passives.length ? <span className="build-card__passives" role="list">{content.passives.map((selection, index) => {
        const definition = resolveEntity(profile, catalogs, selection.ref)
        const cost = definition ? passivePointCost(definition) : undefined
        return <span className="build-card__passive" key={`${entityDefinitionKey(selection.ref)}:${index}`} role="listitem"><SummarySelection catalogs={catalogs} empty="Unavailable" hideLabel label={`Equipped passive ${index + 1}`} profile={profile} ruleset={ruleset} value={selection.ref}/><small>{cost?.state === 'known' ? `${cost.value} PP` : '? PP'}</small></span>
      })}</span> : <small className="sr-only">No passives selected</small>}
    </span>
  </span>
}
