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
  readonly squares: readonly Pick<SkillSquare, 'row' | 'column'>[]
}

function starterRef(id: string): CatalogRef {
  return { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: STARTER_CATALOG_REVISION_ID, entityId: asId<EntityId>(id) }
}

function confirmedClassMap(className: string, assignments: readonly (readonly [number, number, LearnedNodeKind, string])[], unresolved: readonly (readonly [number, number])[] = []): ConfirmedSkillMap {
  const mappings = assignments.map(([row, column, kind, id]) => Object.freeze({ row, column, kind, ref: Object.freeze(starterRef(id)) }))
  return Object.freeze({
    id: `switch-mod-packs-${className}-v1`,
    mapSetId: SWITCH_MOD_PACKS_MAP_SET,
    classRef: Object.freeze(starterRef(`base:class:${className}`)),
    mappings: Object.freeze(mappings),
    squares: Object.freeze([...mappings.map(({ row, column }) => Object.freeze({ row, column })), ...unresolved.map(([row, column]) => Object.freeze({ row, column }))].sort((a, b) => a.row - b.row || a.column - b.column)),
  })
}

function baseClassMap(className: string, squares: readonly (readonly [number, number, LearnedNodeKind, string])[]): ConfirmedSkillMap {
  return confirmedClassMap(className, squares.map(([row, column, kind, name]) => [row, column, kind, `base:${className}:${kind}:${name}`]))
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
  confirmedClassMap('rogue', [
    [0, 0, 'ability', 'base:rogue:ability:steal'],
    [0, 2, 'ability', 'wiki:ability:eye-gouge'],
    [0, 3, 'innate', 'base:rogue:innate:pinpoint'],
    [1, 0, 'ability', 'wiki:ability:backstab'],
    [1, 2, 'ability', 'wiki:ability:sleep-bomb'],
    [2, 0, 'passive', 'base:rogue:passive:equip-dagger'],
    [2, 1, 'ability', 'base:rogue:ability:shadow-cut'],
    [2, 2, 'passive', 'base:rogue:passive:pocket-sand'],
    [2, 3, 'ability', 'wiki:ability:run-away'],
    [3, 1, 'ability', 'wiki:ability:sneak-attack'],
    [3, 3, 'ability', 'wiki:ability:reflex-stance'],
    [4, 1, 'passive', 'base:rogue:passive:backstabber'],
    [4, 2, 'ability', 'wiki:ability:trick-slash'],
    [5, 2, 'ability', 'wiki:ability:rupture'],
  ]),
  confirmedClassMap('cleric', [
    [0, 1, 'ability', 'base:cleric:ability:cure'],
    [0, 2, 'ability', 'base:cleric:ability:spark-shine'],
    [0, 3, 'innate', 'base:cleric:innate:pinch-healer'],
    [1, 0, 'ability', 'base:cleric:ability:mend'],
    [1, 3, 'passive', 'base:cleric:passive:equip-staff'],
    [2, 1, 'ability', 'base:cleric:ability:curen'],
    [2, 2, 'ability', 'base:cleric:ability:spotlight'],
    [3, 0, 'ability', 'base:cleric:ability:raise'],
    [3, 3, 'passive', 'base:cleric:passive:inner-warmth'],
    [4, 0, 'ability', 'base:cleric:ability:return'],
    [4, 3, 'ability', 'base:cleric:ability:blackout'],
    [5, 1, 'ability', 'base:cleric:ability:curena'],
    [5, 2, 'ability', 'base:cleric:ability:star-flare'],
  ]),
  confirmedClassMap('wizard', [
    [0, 1, 'ability', 'base:wizard:ability:fire'],
    [0, 2, 'ability', 'base:wizard:ability:bolt'],
    [0, 3, 'innate', 'base:wizard:innate:element-specialist'],
    [1, 0, 'passive', 'base:wizard:passive:equip-wand'],
    [1, 3, 'passive', 'base:wizard:passive:initial-focus'],
    [2, 1, 'ability', 'base:wizard:ability:firen'],
    [2, 2, 'ability', 'base:wizard:ability:bolten'],
    [3, 1, 'ability', 'base:wizard:ability:firena'],
    [3, 2, 'ability', 'base:wizard:ability:boltena'],
    [4, 0, 'ability', 'base:wizard:ability:mind-stance'],
    [4, 3, 'ability', 'base:wizard:ability:storm-stance'],
    [5, 1, 'ability', 'base:wizard:ability:flare'],
    [5, 2, 'ability', 'base:wizard:ability:thunder'],
  ]),
  confirmedClassMap('warlock', [
    [0, 1, 'ability', 'base:warlock:ability:scan'],
    [0, 3, 'innate', 'base:warlock:innate:chaincaster'],
    [1, 0, 'ability', 'base:warlock:ability:heal'],
    [1, 2, 'ability', 'base:warlock:ability:protect'],
    [1, 3, 'ability', 'base:warlock:ability:blaze'],
    [2, 0, 'ability', 'base:warlock:ability:remedy'],
    [2, 1, 'ability', 'base:warlock:ability:regen'],
    [2, 2, 'ability', 'base:warlock:ability:shell'],
    [2, 3, 'ability', 'base:warlock:ability:douse'],
    [3, 0, 'ability', 'base:warlock:ability:life'],
    [3, 1, 'ability', 'base:warlock:ability:refresh'],
    [3, 2, 'ability', 'base:warlock:ability:dispel'],
    [3, 3, 'ability', 'base:warlock:ability:frost'],
    [4, 0, 'passive', 'base:warlock:passive:regenerator'],
    [4, 1, 'passive', 'base:warlock:passive:refresher'],
    [5, 2, 'ability', 'base:warlock:ability:doublecast'],
  ]),
  confirmedClassMap('fencer', [
    [0, 1, 'ability', 'base:fencer:ability:poison-tip'],
    [0, 2, 'ability', 'base:fencer:ability:barbed-cap'],
    [0, 3, 'innate', 'base:fencer:innate:eagle-talon'],
    [1, 0, 'ability', 'base:fencer:ability:swallowtail'],
    [1, 1, 'ability', 'base:fencer:ability:hawk-stance'],
    [1, 2, 'ability', 'base:fencer:ability:eagle-stance'],
    [1, 3, 'ability', 'base:fencer:ability:piercethrough'],
    [4, 0, 'ability', 'base:fencer:ability:feathercut'],
    [4, 1, 'passive', 'base:fencer:passive:eagle-eye'],
    [4, 2, 'passive', 'base:fencer:passive:equip-rapier'],
    [4, 3, 'ability', 'base:fencer:ability:snowfang'],
    [5, 1, 'ability', 'base:fencer:ability:nighthawk'],
    [5, 2, 'ability', 'base:fencer:ability:checkmate'],
  ]),
  confirmedClassMap('shaman', [
    [0, 0, 'ability', 'base:shaman:ability:acid'],
    [0, 1, 'ability', 'base:shaman:ability:bio'],
    [0, 2, 'ability', 'base:shaman:ability:drain'],
    [0, 3, 'ability', 'base:shaman:ability:instability'],
    [2, 0, 'ability', 'wiki:ability:acid-ii'],
    [2, 1, 'ability', 'wiki:ability:bio-ii'],
    [2, 2, 'passive', 'base:shaman:passive:safeguard'],
    [2, 3, 'ability', 'base:shaman:ability:sleep-echo'],
    [5, 0, 'innate', 'base:shaman:innate:spell-steal'],
    [5, 1, 'ability', 'wiki:ability:epidemic'],
    [5, 2, 'ability', 'base:shaman:ability:stone-core'],
    [5, 3, 'ability', 'base:shaman:ability:mist-core'],
  ]),
  confirmedClassMap('scholar', [
    [0, 1, 'innate', 'base:scholar:innate:learning'],
    [0, 2, 'passive', 'base:scholar:passive:equip-book'],
    [0, 3, 'innate', 'base:scholar:innate:studious'],
    [1, 0, 'monsterMagic', 'base:scholar:monster-magic:infusion'],
    [1, 1, 'monsterMagic', 'base:scholar:monster-magic:regenerate'],
    [1, 2, 'monsterMagic', 'base:scholar:monster-magic:sun-bath'],
    [1, 3, 'monsterMagic', 'base:scholar:monster-magic:roost'],
    [2, 0, 'monsterMagic', 'base:scholar:monster-magic:build-life'],
    [2, 1, 'monsterMagic', 'base:scholar:monster-magic:lifegiver'],
    [2, 2, 'monsterMagic', 'base:scholar:monster-magic:reverse-polarity'],
    [2, 3, 'monsterMagic', 'base:scholar:monster-magic:barrier'],
    [3, 1, 'monsterMagic', 'base:scholar:monster-magic:adrenaline'],
    [3, 2, 'monsterMagic', 'base:scholar:monster-magic:aero'],
    [3, 3, 'monsterMagic', 'base:scholar:monster-magic:whirlwind'],
    [4, 0, 'monsterMagic', 'base:scholar:monster-magic:fire-breath'],
    [4, 1, 'monsterMagic', 'base:scholar:monster-magic:lucky-dice'],
    [4, 2, 'monsterMagic', 'base:scholar:monster-magic:explode'],
    [4, 3, 'monsterMagic', 'base:scholar:monster-magic:mp-sickle'],
    [5, 0, 'monsterMagic', 'base:scholar:monster-magic:atmoshear'],
    [5, 1, 'monsterMagic', 'base:scholar:monster-magic:sleep-aura'],
    [5, 2, 'monsterMagic', 'base:scholar:monster-magic:overload'],
    [5, 3, 'monsterMagic', 'base:scholar:monster-magic:insult'],
  ], [[3, 0]]),
  confirmedClassMap('aegis', [
    [0, 0, 'ability', 'base:aegis:ability:cover'],
    [0, 3, 'ability', 'base:aegis:ability:entrench'],
    [1, 0, 'ability', 'base:aegis:ability:armor-boost'],
    [1, 1, 'passive', 'base:aegis:passive:natural-tank'],
    [1, 2, 'passive', 'base:aegis:passive:equip-shield'],
    [1, 3, 'ability', 'base:aegis:ability:resist-boost'],
    [2, 1, 'passive', 'base:aegis:passive:stalwart'],
    [2, 2, 'passive', 'base:aegis:passive:stance-tank'],
    [3, 0, 'ability', 'base:aegis:ability:magic-break'],
    [3, 3, 'ability', 'base:aegis:ability:resist-break'],
    [4, 1, 'ability', 'base:aegis:ability:power-wall'],
    [4, 2, 'ability', 'base:aegis:ability:magic-wall'],
    [5, 1, 'ability', 'base:aegis:ability:crystal-form'],
    [5, 2, 'ability', 'base:aegis:ability:reprisal-aura'],
    [5, 3, 'innate', 'base:aegis:innate:white-knight'],
  ]),
  confirmedClassMap('hunter', [
    [0, 0, 'innate', 'base:hunter:innate:camouflage'],
    [0, 3, 'ability', 'base:hunter:ability:quickshot'],
    [1, 2, 'ability', 'base:hunter:ability:take-aim'],
    [1, 3, 'ability', 'base:hunter:ability:track'],
    [2, 1, 'ability', 'base:hunter:ability:barrage'],
    [2, 2, 'passive', 'base:hunter:passive:equip-bow'],
    [2, 3, 'ability', 'base:hunter:ability:unguent'],
    [3, 0, 'ability', 'base:hunter:ability:thorned-shot'],
    [3, 1, 'passive', 'base:hunter:passive:perfect-vision'],
    [3, 3, 'ability', 'base:hunter:ability:hide'],
    [4, 3, 'ability', 'base:hunter:ability:hunter-s-mark'],
    [5, 1, 'ability', 'base:hunter:ability:pickoff'],
    [5, 2, 'passive', 'base:hunter:passive:covert'],
    [5, 3, 'ability', 'base:hunter:ability:snipe'],
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
  const confirmedMap = CONFIRMED_SKILL_MAPS.find(map => map.mapSetId === mapSetId && entityDefinitionKey(map.classRef) === entityDefinitionKey(root) && skillTreeShape(map.squares) === skillTreeShape(squares))
  if (!confirmedMap || resolveDefinition(profile, catalogs, classRef)?.kind !== 'class') return { mappings: saved }
  const mappings = confirmedMap.mappings.map(mapping => ({ ...mapping, ref: preferredDefinitionRef(profile, mapping.ref) }))
  if (mappings.some(mapping => resolveDefinition(profile, catalogs, mapping.ref)?.kind !== mapping.kind)) return { mappings: saved }
  if (saved.some(prior => {
    const expected = mappings.find(next => squareKey(prior) === squareKey(next))
    return expected ? prior.kind !== expected.kind || !sameLogicalEntity(profile, prior.ref, expected.ref) : !confirmedMap.squares.some(square => squareKey(square) === squareKey(prior))
  })) return { mappings: saved }
  const retained = saved.filter(prior => !mappings.some(next => squareKey(prior) === squareKey(next)))
  return { mappings: [...mappings.map(mapping => saved.find(prior => squareKey(prior) === squareKey(mapping)) ?? mapping), ...retained].sort((a, b) => a.row - b.row || a.column - b.column), confirmedMap }
}
