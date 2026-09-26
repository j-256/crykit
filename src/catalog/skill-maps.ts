import { CONFIRMED_SWITCH_MOD_SETUP } from './mods'
import { normalizeModName } from '../domain/mods'
import { asId, entityDefinitionKey } from '../domain/core'
import { definitionLineageRootRef, preferredDefinitionRef, resolveDefinition, sameLogicalEntity } from '../domain/definitions'
import { findSkillTreeLayout, skillTreeShape, squareKey } from '../domain/skill-trees'
import type { CatalogRef, CatalogSnapshot, EntityId, EntityRef, LearnedNodeKind, Profile, RulesetRevision, RulesetRevisionId, SkillSquare, SkillTreeMapping } from '../domain/types'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'

export const SWITCH_MOD_PACKS_MAP_SET = CONFIRMED_SWITCH_MOD_SETUP.id
export const CONFIRMED_SKILL_MAP_SETS = Object.freeze([CONFIRMED_SWITCH_MOD_SETUP])

export interface ConfirmedSkillMap {
  readonly id: string
  readonly mapSetId: string
  readonly classRef: CatalogRef
  readonly mappings: readonly SkillTreeMapping[]
}

function starterRef(id: string): CatalogRef {
  return { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: STARTER_CATALOG_REVISION_ID, entityId: asId<EntityId>(id) }
}

function baseClassMap(className: string, squares: readonly (readonly [number, number, LearnedNodeKind, string])[]): ConfirmedSkillMap {
  return Object.freeze({
    id: `switch-mod-packs-${className}-v1`,
    mapSetId: SWITCH_MOD_PACKS_MAP_SET,
    classRef: Object.freeze(starterRef(`base:class:${className}`)),
    mappings: Object.freeze(squares.map(([row, column, kind, name]) => Object.freeze({ row, column, kind, ref: Object.freeze(starterRef(`base:${className}:${kind}:${name}`)) }))),
  })
}

// Position names checked in game on Nintendo Switch with both mod packs on 2026-09-26
// The map set records enabled and disabled mods; the game version was not reported
export const CONFIRMED_SKILL_MAPS: readonly ConfirmedSkillMap[] = Object.freeze([
  baseClassMap('warrior', [
    [0, 1, 'ability', 'taunt'],
    [0, 3, 'innate', 'fighter'],
    [1, 0, 'ability', 'defender'],
    [1, 2, 'ability', 'berserker'],
    [2, 1, 'passive', 'equip-sword'],
    [2, 3, 'passive', 'equip-axe'],
    [3, 0, 'ability', 'power-break'],
    [3, 2, 'ability', 'armor-break'],
    [4, 0, 'ability', 'bruiser-crush'],
    [4, 1, 'ability', 'paragon-crush'],
    [4, 2, 'ability', 'blitz-crush'],
    [4, 3, 'ability', 'battle-crush'],
    [5, 1, 'passive', 'grudge'],
    [5, 3, 'passive', 'adrenaline'],
  ]),
  baseClassMap('monk', [
    [0, 1, 'ability', 'meditate'],
    [0, 2, 'ability', 'beat-down'],
    [0, 3, 'innate', 'aversive'],
    [1, 1, 'ability', 'first-aid'],
    [1, 2, 'ability', 'earth-split'],
    [2, 0, 'innate', 'brawler'],
    [2, 1, 'ability', 'chakra'],
    [2, 2, 'ability', 'thunder-chop'],
    [2, 3, 'passive', 'counter'],
    [3, 1, 'ability', 'focus-energy'],
    [3, 2, 'ability', 'wind-punch'],
    [4, 0, 'passive', 'hp-boost'],
    [5, 1, 'ability', 'revive'],
    [5, 2, 'ability', 'chi-burst'],
  ]),
])

export function skillMapSetForRuleset(ruleset?: RulesetRevision): string {
  if (ruleset?.platform.state !== 'known' || !['switch', 'nintendo switch'].includes(normalizeModName(ruleset.platform.value)) || ruleset.mods.state !== 'known' || ruleset.disabledMods?.state !== 'known') return ''
  const equalNames = (left: readonly string[], right: readonly string[]) => {
    const names = new Set(left.map(normalizeModName))
    return names.size === right.length && right.every(name => names.has(normalizeModName(name)))
  }
  const enabled = ruleset.mods.value
  const disabled = ruleset.disabledMods.value
  return CONFIRMED_SKILL_MAP_SETS.find(set => equalNames(enabled, set.enabledMods) && equalNames(disabled, set.disabledMods))?.id ?? ''
}

export interface SkillMapSuggestion {
  readonly mappings: readonly SkillTreeMapping[]
  readonly confirmedMap?: ConfirmedSkillMap
}

export function suggestSkillTreeMap(profile: Profile, catalogs: readonly CatalogSnapshot[], classRef: EntityRef, squares: readonly SkillSquare[], mapSetId: string, rulesetRevisionId?: RulesetRevisionId, draftMappings?: readonly SkillTreeMapping[]): SkillMapSuggestion {
  const saved = draftMappings ?? findSkillTreeLayout(profile, classRef, squares, rulesetRevisionId)?.mappings ?? []
  const root = definitionLineageRootRef(profile, classRef)
  const confirmedMap = CONFIRMED_SKILL_MAPS.find(map => map.mapSetId === mapSetId && entityDefinitionKey(map.classRef) === entityDefinitionKey(root) && skillTreeShape(map.mappings) === skillTreeShape(squares))
  if (!confirmedMap || resolveDefinition(profile, catalogs, classRef)?.kind !== 'class') return { mappings: saved }
  const mappings = confirmedMap.mappings.map(mapping => ({ ...mapping, ref: preferredDefinitionRef(profile, mapping.ref) }))
  if (mappings.some(mapping => resolveDefinition(profile, catalogs, mapping.ref)?.kind !== mapping.kind)) return { mappings: saved }
  if (saved.some(prior => !mappings.some(next => squareKey(prior) === squareKey(next) && prior.kind === next.kind && sameLogicalEntity(profile, prior.ref, next.ref)))) return { mappings: saved }
  return { mappings: mappings.map(mapping => saved.find(prior => squareKey(prior) === squareKey(mapping)) ?? mapping), confirmedMap }
}
