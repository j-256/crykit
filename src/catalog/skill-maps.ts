import { CONFIRMED_SWITCH_MOD_SETUP } from './mods'
import { normalizeModName } from '../domain/mods'
import { asId, entityDefinitionKey } from '../domain/core'
import { definitionLineageRootRef, preferredDefinitionRef, resolveDefinition, sameLogicalEntity } from '../domain/definitions'
import { findSkillTreeLayout, skillTreeShape, squareKey } from '../domain/skill-trees'
import type { CatalogRef, CatalogSnapshot, EntityId, EntityRef, LearnedNodeKind, LocalData, GameSetupRevision, GameSetupRevisionId, SkillSquare, SkillTreeMapping } from '../domain/types'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'
import { compileBundledSourceId } from './bundled'

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
  return { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: STARTER_CATALOG_REVISION_ID, entityId: asId<EntityId>(compileBundledSourceId(id)) }
}

function confirmedClassMap(className: string, assignments: readonly (readonly [number, number, LearnedNodeKind, string])[], unresolved: readonly (readonly [number, number])[] = [], classId = `base:class:${className}`): ConfirmedSkillMap {
  const mappings = assignments.map(([row, column, kind, id]) => Object.freeze({ row, column, kind, ref: Object.freeze(starterRef(id)) }))
  return Object.freeze({
    id: `switch-mod-packs-${className}-v1`,
    mapSetId: SWITCH_MOD_PACKS_MAP_SET,
    classRef: Object.freeze(starterRef(classId)),
    mappings: Object.freeze(mappings),
    squares: Object.freeze([...mappings.map(({ row, column }) => Object.freeze({ row, column })), ...unresolved.map(([row, column]) => Object.freeze({ row, column }))].sort((a, b) => a.row - b.row || a.column - b.column)),
  })
}

function baseClassMap(className: string, squares: readonly (readonly [number, number, LearnedNodeKind, string])[]): ConfirmedSkillMap {
  return confirmedClassMap(className, squares.map(([row, column, kind, name]) => [row, column, kind, `base:${className}:${kind}:${name}`]))
}

// Position names checked in game on Nintendo Switch with both mod packs on 2026-09-26
// The maintainer identifies these observations as Nintendo Switch 1.6.6
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
    [0, 2, 'ability', 'base:ability:43'],
    [0, 3, 'innate', 'base:rogue:innate:pinpoint'],
    [1, 0, 'ability', 'base:ability:38'],
    [1, 2, 'ability', 'base:ability:44'],
    [2, 0, 'passive', 'base:rogue:passive:equip-dagger'],
    [2, 1, 'ability', 'base:rogue:ability:shadow-cut'],
    [2, 2, 'passive', 'base:rogue:passive:pocket-sand'],
    [2, 3, 'ability', 'base:ability:45'],
    [3, 1, 'ability', 'base:ability:9'],
    [3, 3, 'ability', 'base:ability:112'],
    [4, 1, 'passive', 'base:rogue:passive:backstabber'],
    [4, 2, 'ability', 'base:ability:39'],
    [5, 2, 'ability', 'base:ability:41'],
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
    [2, 0, 'ability', 'base:ability:321'],
    [2, 1, 'ability', 'base:ability:320'],
    [2, 2, 'passive', 'base:shaman:passive:safeguard'],
    [2, 3, 'ability', 'base:shaman:ability:sleep-echo'],
    [5, 0, 'innate', 'base:shaman:innate:spell-steal'],
    [5, 1, 'ability', 'base:ability:121'],
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
  confirmedClassMap('chemist', [
    [0, 1, 'ability', 'base:chemist:ability:tonic'],
    [0, 2, 'ability', 'base:chemist:ability:tincture'],
    [0, 3, 'innate', 'base:chemist:innate:efficience'],
    [1, 0, 'ability', 'base:chemist:ability:fenix-juice'],
    [1, 1, 'ability', 'base:chemist:ability:potion'],
    [1, 2, 'ability', 'base:chemist:ability:ether'],
    [1, 3, 'passive', 'base:passive:14'],
    [2, 0, 'ability', 'base:chemist:ability:fenix-syrup'],
    [2, 1, 'ability', 'base:chemist:ability:z-potion'],
    [2, 2, 'ability', 'base:chemist:ability:zether'],
    [2, 3, 'passive', 'base:passive:86'],
    [3, 0, 'ability', 'base:chemist:ability:levigel'],
    [3, 1, 'ability', 'base:chemist:ability:smoke-bomb'],
    [3, 2, 'ability', 'base:chemist:ability:mp-juice'],
    [3, 3, 'ability', 'base:chemist:ability:fig-mixture'],
    [5, 0, 'ability', 'base:chemist:ability:invisigel'],
    [5, 1, 'ability', 'base:chemist:ability:heal-oil'],
    [5, 2, 'ability', 'base:chemist:ability:ap-juice'],
    [5, 3, 'ability', 'base:chemist:ability:sap-mixture'],
  ]),
  baseClassMap('reaper', [
    [0, 0, 'ability', 'reaping-cut'],
    [0, 1, 'ability', 'lifedrink'],
    [0, 3, 'innate', 'reaping'],
    [1, 0, 'ability', 'rending-cut'],
    [1, 1, 'ability', 'bloodwell'],
    [2, 0, 'ability', 'frenzy'],
    [2, 1, 'ability', 'expertise'],
    [3, 0, 'passive', 'blood-spiller'],
    [3, 1, 'ability', 'satanic'],
    [4, 0, 'ability', 'nightfall'],
    [4, 2, 'passive', 'equip-scythe'],
    [5, 1, 'ability', 'guillotine'],
    [5, 2, 'passive', 'initial-oomph'],
    [5, 3, 'ability', 'moon-slash'],
  ]),
  confirmedClassMap('ninja', [
    [0, 1, 'ability', 'base:ability:165'],
    [0, 2, 'ability', 'base:ability:412'],
    [0, 3, 'innate', 'base:ninja:innate:dual-wield'],
    [1, 0, 'passive', 'base:passive:51'],
    [1, 3, 'passive', 'base:passive:19'],
    [2, 0, 'ability', 'base:ability:166'],
    [2, 3, 'ability', 'base:ability:167'],
    [3, 1, 'ability', 'base:ability:169'],
    [3, 2, 'ability', 'base:ability:170'],
    [4, 0, 'ability', 'base:ability:470'],
    [4, 3, 'ability', 'base:ability:475'],
    [5, 1, 'ability', 'base:ability:168'],
    [5, 2, 'ability', 'base:ability:171'],
  ]),
  confirmedClassMap('dervish', [
    [0, 1, 'ability', 'base:dervish:ability:quakesand'],
    [0, 2, 'ability', 'base:ability:135'],
    [0, 3, 'innate', 'base:dervish:innate:aura'],
    [1, 0, 'ability', 'base:dervish:ability:fissure'],
    [1, 3, 'ability', 'base:ability:136'],
    [2, 1, 'ability', 'base:ability:237'],
    [2, 2, 'passive', 'base:dervish:passive:focus-shield'],
    [3, 0, 'ability', 'base:ability:134'],
    [3, 3, 'ability', 'base:ability:140'],
    [4, 1, 'ability', 'base:ability:139'],
    [4, 2, 'passive', 'base:dervish:passive:critical-power'],
    [4, 3, 'ability', 'base:ability:137'],
    [5, 2, 'ability', 'base:ability:138'],
  ]),
  baseClassMap('beatsmith', [
    [0, 0, 'ability', 'bass-kick'],
    [0, 3, 'innate', 'rhythm'],
    [1, 1, 'ability', 'beat-roll'],
    [2, 0, 'ability', 'defense-style'],
    [2, 1, 'passive', 'auto-speed'],
    [2, 2, 'ability', 'resistance-style'],
    [3, 0, 'passive', 'critical-turn'],
    [3, 1, 'ability', 'rhythm-break'],
    [3, 2, 'ability', 'third-act'],
    [3, 3, 'ability', 'mana-song'],
    [4, 0, 'ability', 'rhapsody'],
    [4, 3, 'ability', 'requiem'],
    [5, 2, 'ability', 'crescendo'],
  ]),
  confirmedClassMap('samurai', [
    [0, 0, 'ability', 'base:ability:189'],
    [0, 1, 'ability', 'base:ability:190'],
    [0, 2, 'innate', 'base:samurai:innate:two-handed'],
    [0, 3, 'innate', 'base:samurai:innate:endless-fury'],
    [1, 1, 'ability', 'base:samurai:ability:ken-asura'],
    [1, 2, 'passive', 'base:samurai:passive:equip-katana'],
    [2, 0, 'ability', 'base:ability:191'],
    [2, 2, 'passive', 'base:samurai:passive:fury'],
    [3, 1, 'ability', 'base:ability:192'],
    [3, 3, 'ability', 'base:ability:193'],
    [4, 2, 'passive', 'base:samurai:passive:unreactable'],
    [4, 3, 'ability', 'base:samurai:ability:ken-heavenslash'],
    [5, 3, 'ability', 'base:samurai:ability:ken-omnislice'],
  ]),
  confirmedClassMap('assassin', [
    [0, 0, 'ability', 'base:assassin:ability:bloody-slice'],
    [0, 1, 'innate', 'base:assassin:innate:assassination'],
    [0, 2, 'ability', 'base:assassin:ability:harm-power'],
    [0, 3, 'ability', 'base:ability:219'],
    [1, 0, 'ability', 'base:assassin:ability:maim-focus'],
    [1, 2, 'ability', 'base:ability:335'],
    [2, 0, 'ability', 'base:assassin:ability:maim-sustain'],
    [2, 3, 'ability', 'base:ability:217'],
    [3, 2, 'ability', 'base:ability:216'],
    [3, 3, 'ability', 'base:ability:332'],
    [4, 0, 'passive', 'base:assassin:passive:venom-coat'],
    [5, 1, 'ability', 'base:assassin:ability:coup-de-grace'],
    [5, 3, 'passive', 'base:assassin:passive:crippling-coat'],
  ]),
  confirmedClassMap('valkyrie', [
    [0, 2, 'ability', 'base:valkyrie:ability:warcry'],
    [0, 3, 'innate', 'base:valkyrie:innate:immortal'],
    [1, 3, 'ability', 'base:ability:109'],
    [2, 0, 'ability', 'base:valkyrie:ability:bracing-strike'],
    [2, 2, 'ability', 'base:ability:117'],
    [2, 3, 'passive', 'base:passive:15'],
    [3, 0, 'ability', 'base:ability:115'],
    [3, 1, 'passive', 'base:passive:34'],
    [3, 2, 'ability', 'base:ability:334'],
    [3, 3, 'ability', 'base:ability:110'],
    [4, 1, 'passive', 'base:passive:28'],
    [4, 2, 'ability', 'base:ability:113'],
    [4, 3, 'ability', 'base:ability:116'],
    [5, 2, 'ability', 'base:ability:118'],
  ]),
  confirmedClassMap('summoner', [
    [0, 1, 'innate', 'base:summoner:innate:mp-boost'],
    [0, 2, 'passive', 'base:summoner:passive:initial-resist'],
    [1, 0, 'ability', 'base:summoner:ability:pinga'],
    [2, 0, 'ability', 'base:summoner:ability:shaku'],
  ], [[1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [4, 1], [4, 2]]),
  confirmedClassMap('beastmaster', [
    [0, 1, 'innate', 'base:beastmaster:innate:morphology'],
    [0, 2, 'ability', 'base:beastmaster:ability:feast'],
    [0, 3, 'innate', 'base:beastmaster:innate:savage'],
    [1, 1, 'ability', 'base:beastmaster:ability:gouge'],
    [1, 2, 'ability', 'base:ability:343'],
    [1, 3, 'ability', 'base:ability:220'],
    [2, 0, 'passive', 'base:beastmaster:passive:threatening'],
    [3, 0, 'ability', 'base:ability:300'],
    [3, 1, 'ability', 'base:ability:318'],
    [3, 2, 'ability', 'base:ability:214'],
    [3, 3, 'ability', 'base:beastmaster:ability:famine'],
    [4, 0, 'passive', 'base:beastmaster:passive:duel-ready'],
    [5, 1, 'ability', 'base:ability:345'],
    [5, 2, 'ability', 'base:ability:211'],
    [5, 3, 'ability', 'base:ability:209'],
  ]),
  confirmedClassMap('barbarian', [
    [0, 0, 'ability', 'mod:barbarian:ability:shout'],
    [1, 0, 'ability', 'mod:barbarian:ability:thick-skin'],
    [1, 1, 'ability', 'mod:barbarian:ability:enrage'],
    [2, 0, 'passive', 'mod:barbarian:passive:hardy'],
    [2, 1, 'ability', 'mod:barbarian:ability:battlecry'],
    [2, 2, 'ability', 'mod:barbarian:ability:second-wind'],
    [3, 1, 'passive', 'mod:barbarian:passive:ferocious'],
    [3, 2, 'ability', 'mod:barbarian:ability:rally'],
    [3, 3, 'ability', 'mod:barbarian:ability:grapple'],
    [4, 2, 'passive', 'mod:barbarian:passive:endurance'],
    [4, 3, 'ability', 'mod:barbarian:ability:overpower'],
    [5, 3, 'ability', 'mod:barbarian:ability:momentum'],
  ], [], 'mod:barbarian:class:barbarian'),
  confirmedClassMap('tempest', [
    [0, 1, 'ability', 'mod:tempest:ability:flurry'],
    [1, 0, 'passive', 'mod:tempest:passive:preparation'],
    [1, 2, 'ability', 'mod:tempest:ability:thunder-stance'],
    [2, 0, 'ability', 'mod:tempest:ability:chain-lightning'],
    [2, 3, 'ability', 'mod:tempest:ability:wind-stance'],
    [3, 0, 'ability', 'mod:tempest:ability:charge'],
    [3, 2, 'ability', 'mod:tempest:ability:gale'],
    [3, 3, 'ability', 'mod:tempest:ability:swipe'],
    [5, 0, 'ability', 'mod:tempest:ability:jolt'],
    [5, 1, 'ability', 'mod:tempest:ability:lightning-strike'],
    [5, 2, 'ability', 'mod:tempest:ability:hurricane'],
    [5, 3, 'passive', 'mod:tempest:passive:fast-hands'],
  ], [], 'mod:tempest:class:tempest'),
  confirmedClassMap('brawler', [
    [0, 0, 'ability', 'mod:moonlight-project:ability:616'],
    [0, 2, 'ability', 'mod:moonlight-project:ability:540'],
    [1, 0, 'ability', 'mod:moonlight-project:ability:617'],
    [2, 0, 'ability', 'mod:moonlight-project:ability:618'],
    [3, 0, 'passive', 'mod:moonlight-project:passive:97'],
    [3, 2, 'ability', 'mod:moonlight-project:ability:552'],
    [4, 0, 'passive', 'mod:moonlight-project:passive:99'],
    [5, 0, 'passive', 'mod:moonlight-project:passive:100'],
  ], [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [4, 1], [4, 2], [4, 3], [5, 1], [5, 2], [5, 3]], 'mod:moonlight-project:class:25'),
  confirmedClassMap('freelancer', [
    [0, 0, 'ability', 'mod:moonlight-project:ability:557'],
    [0, 1, 'ability', 'mod:moonlight-project:ability:560'],
    [0, 2, 'ability', 'mod:moonlight-project:ability:572'],
    [1, 0, 'ability', 'mod:moonlight-project:ability:558'],
    [1, 1, 'ability', 'mod:moonlight-project:ability:561'],
    [1, 2, 'ability', 'mod:moonlight-project:ability:562'],
    [1, 3, 'passive', 'mod:moonlight-project:passive:116'],
    [2, 0, 'ability', 'mod:moonlight-project:ability:559'],
    [2, 1, 'ability', 'mod:moonlight-project:ability:566'],
    [2, 2, 'ability', 'mod:moonlight-project:ability:563'],
    [3, 0, 'ability', 'mod:moonlight-project:ability:564'],
    [3, 1, 'ability', 'mod:moonlight-project:ability:567'],
    [3, 2, 'ability', 'mod:moonlight-project:ability:569'],
    [3, 3, 'passive', 'mod:moonlight-project:passive:115'],
    [4, 0, 'ability', 'mod:moonlight-project:ability:570'],
    [4, 1, 'ability', 'mod:moonlight-project:ability:568'],
    [4, 2, 'ability', 'mod:moonlight-project:ability:571'],
    [5, 1, 'ability', 'mod:moonlight-project:ability:565'],
    [5, 3, 'passive', 'mod:moonlight-project:passive:114'],
  ], [], 'mod:moonlight-project:class:26'),
])

export function skillMapSetForGameSetup(gameSetup?: GameSetupRevision): string {
  if (gameSetup?.platform.state !== 'known' || !['switch', 'nintendo switch'].includes(normalizeModName(gameSetup.platform.value)) || gameSetup.mods.state !== 'known' || gameSetup.disabledMods?.state !== 'known') return ''
  const equalNames = (left: readonly string[], right: readonly string[]) => {
    const names = new Set(left.map(normalizeModName))
    return names.size === right.length && right.every(name => names.has(normalizeModName(name)))
  }
  const enabled = gameSetup.mods.value
  const disabled = gameSetup.disabledMods.value
  return CONFIRMED_SKILL_MAP_SETS.find(set => equalNames(enabled, set.enabledMods) && equalNames(disabled, set.disabledMods))?.id ?? ''
}

export interface SkillMapSuggestion {
  readonly mappings: readonly SkillTreeMapping[]
  readonly confirmedMap?: ConfirmedSkillMap
}

export function suggestSkillTreeMap(localData: LocalData, catalogs: readonly CatalogSnapshot[], classRef: EntityRef, squares: readonly SkillSquare[], mapSetId: string, gameSetupRevisionId?: GameSetupRevisionId, draftMappings?: readonly SkillTreeMapping[]): SkillMapSuggestion {
  const saved = draftMappings ?? findSkillTreeLayout(localData, classRef, squares, gameSetupRevisionId)?.mappings ?? []
  const root = definitionLineageRootRef(localData, classRef)
  const confirmedMap = CONFIRMED_SKILL_MAPS.find(map => map.mapSetId === mapSetId && entityDefinitionKey(map.classRef) === entityDefinitionKey(root) && skillTreeShape(map.squares) === skillTreeShape(squares))
  if (!confirmedMap || resolveDefinition(localData, catalogs, classRef)?.kind !== 'class') return { mappings: saved }
  const mappings = confirmedMap.mappings.map(mapping => ({ ...mapping, ref: preferredDefinitionRef(localData, mapping.ref) }))
  if (mappings.some(mapping => resolveDefinition(localData, catalogs, mapping.ref)?.kind !== mapping.kind)) return { mappings: saved }
  if (saved.some(prior => {
    const expected = mappings.find(next => squareKey(prior) === squareKey(next))
    return expected ? prior.kind !== expected.kind || !sameLogicalEntity(localData, prior.ref, expected.ref) : !confirmedMap.squares.some(square => squareKey(square) === squareKey(prior))
  })) return { mappings: saved }
  const retained = saved.filter(prior => !mappings.some(next => squareKey(prior) === squareKey(next)))
  return { mappings: [...mappings.map(mapping => saved.find(prior => squareKey(prior) === squareKey(mapping)) ?? mapping), ...retained].sort((a, b) => a.row - b.row || a.column - b.column), confirmedMap }
}
