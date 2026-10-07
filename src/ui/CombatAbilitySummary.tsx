import { useMemo } from 'react'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { nativeDescription } from '../catalog/native-description'
import { calculationModResolver } from '../domain/calculation-mods'
import { crystalEditPlanningRecord } from '../domain/crystal-edit-compatibility'
import { sameValue } from '../domain/definition-values'
import { gameSetupMode } from '../domain/game-rules'
import { describeNativeRecord } from '../domain/native-description'
import { nativeDisplayName, nativeIdentity, nativeRecord, nativeSourceRecord, type NativeRecord } from '../domain/native-game'
import { nativeStatRecord } from '../domain/native-stat-record'
import type { BuildCalculationPlan, CatalogSnapshot, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import { SourceReferences } from './KnowledgeValue'
import { resolveCalculationEntity, resolveEntity } from './model'
import { Sources } from './Sources'
import { ArtworkPlaceholder, CatalogArtwork } from './WikiSprite'
import './combat-ability-summary.css'

const UNKNOWN = 'Unknown'
const SCOPE_LABELS: Readonly<Record<string, string>> = Object.freeze({ Single: 'Single target', Multiple: 'Multiple targets', Everything: 'All combatants' })
const LOCKED_TARGET_LABELS: Readonly<Record<string, string>> = Object.freeze({ Enemy: 'enemies', Ally: 'allies', DeadAlly: 'fallen allies' })
const EFFECT_FIELDS = ['AbilityMods', 'TargetStatuses', 'UserStatuses'] as const

function enumName(type: string, value: unknown): string | undefined {
  return typeof value === 'number' ? NATIVE_GAME_DATA.enums[type]?.[value] : undefined
}

function baseScope(record: NativeRecord): string {
  const target = enumName('SangAbilityTarget', record.Target)
  if (target === 'SelfOnly') return 'Self'
  if (target === 'DeadSelfOnly') return 'Self, when fallen'
  const scope = enumName('SangAbilityScope', record.Scope)
  if (scope === 'Everything') return SCOPE_LABELS.Everything!
  const label = scope && SCOPE_LABELS[scope]
  if (!label || typeof record.ScopeLocked !== 'boolean') return UNKNOWN
  if (!record.ScopeLocked) return label
  const restriction = target && LOCKED_TARGET_LABELS[target]
  return restriction ? `${label} (${restriction})` : UNKNOWN
}

function abilityType(record: NativeRecord): string {
  if (typeof record.IsPAbil !== 'boolean' || typeof record.IsMAbil !== 'boolean') return UNKNOWN
  if (record.IsPAbil && record.IsMAbil) return 'Physical / Magic'
  return record.IsPAbil ? 'Physical' : record.IsMAbil ? 'Magic' : 'Ability'
}

export function CombatAbilitySummary({ abilityRef, localData, catalogs, gameSetup, pcMode }: { abilityRef: EntityRef | null; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; pcMode?: BuildCalculationPlan['pcMode'] }) {
  const summary = useMemo(() => {
    if (!abilityRef) return undefined
    const definition = resolveEntity(localData, catalogs, abilityRef)
    const scope = calculationModResolver(ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup))
    const selected = scope.resolve(abilityRef)
    const sourceField = selected?.fields['Crystal Edit source record'] ?? selected?.fields['Native source record']
    const invalidSource = sourceField?.state !== 'known' || !nativeRecord(sourceField.value) || selected?.fields['Crystal Edit source record'] && !crystalEditPlanningRecord(selected)
    const mode = gameSetupMode(gameSetup) ?? pcMode ?? 'standard'
    const record = invalidSource ? undefined : nativeStatRecord(abilityRef, 'ability', scope.resolve, mode) as NativeRecord | undefined
    const identity = definition && nativeIdentity(definition)
    const sameMode = identity && (mode === 'standard' ? identity.mode === 'base' : identity.mode.toLowerCase() === mode)
    const verifiedNative = definition && record && sameMode && sameValue(record, nativeSourceRecord(definition)) && nativeDescription(definition)
    const effects = verifiedNative ? describeNativeRecord(NATIVE_GAME_DATA, 'ability', {
      ...record, Description: null, HideScopeFromDescription: true, BasePower: 0,
      HPCost: 0, MPCost: 0, APCost: 0, CTCost: 0, CDCost: 0,
      BaseAcc: 0, BaseCritChance: 0, BaseCritDmg: 0, BaseVar: 0, Element: null,
    }, nativeIdentity(definition)!.mode).lines : []
    const additionalEffects = record && EFFECT_FIELDS.some(field => Array.isArray(record[field]) && record[field].length > 0)
    const unknownEffects = record && EFFECT_FIELDS.some(field => !Array.isArray(record[field]))
    return { definition, record, effects, additionalEffects, unknownEffects, issues: [...scope.issues] }
  }, [abilityRef, localData, catalogs, gameSetup, pcMode])
  if (!abilityRef || !summary) return null
  const { definition, record, effects, additionalEffects, unknownEffects, issues } = summary
  const name = definition ? nativeDisplayName(definition, definition.name) : 'Unresolved ability'
  const attribute = enumName('SangAbilityAttribute', record?.Attribute)
  const basePower = typeof record?.BasePower === 'number' && Number.isSafeInteger(record.BasePower) ? record.BasePower : undefined
  const element = record?.Element === null ? 'None' : enumName('ElementType', record?.Element) ?? UNKNOWN
  const facts = [{ label: 'Type', value: record ? abilityType(record) : UNKNOWN }, { label: 'Base scope', value: record ? baseScope(record) : UNKNOWN }, { label: 'Ability element', value: element }]
  return <section aria-label="Selected ability" className="combat-ability-summary">
    <div className="combat-ability-summary__heading">
      <div className="combat-ability-summary__artwork">{definition && abilityRef.kind === 'catalog' ? <CatalogArtwork catalogId={abilityRef.catalogId} entity={{ ...definition, id: abilityRef.entityId }}/> : <ArtworkPlaceholder entity={{ kind: definition?.kind ?? 'ability', name }}/>}</div>
      <div className="combat-ability-summary__identity"><h4>{name}</h4><dl className="combat-ability-summary__facts">{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></div>
      {definition && <Sources label={`Ability sources for ${name}`}><SourceReferences includeGameExports sources={definition.sources}/></Sources>}
    </div>
    {record ? <div className="combat-ability-summary__behavior">
      {basePower !== undefined && basePower !== 0 && <p><strong>Base power: {basePower.toLocaleString()}{attribute && ['HP', 'MP', 'AP'].includes(attribute) ? ` ${attribute}` : ''}</strong><span>Before scaling and battle modifiers.</span></p>}
      {effects.length > 0 && <div><span className="combat-ability-summary__label">Base effects</span><ul>{effects.map(line => <li key={line}>{line}</li>)}</ul></div>}
      {!effects.length && additionalEffects && <p className="combat-ability-summary__unknown">This ability has additional effects. Check the battle results; no description is available.</p>}
      {unknownEffects && <p className="combat-ability-summary__unknown">This source does not describe the additional effects.</p>}
    </div> : <p className="combat-ability-summary__unknown">{issues.join(' ') || 'Ability details are unavailable.'}</p>}
  </section>
}
