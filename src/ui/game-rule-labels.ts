import type { GameRuleChange } from '../domain/game-rules'

interface GameRuleLabel {
  readonly label: string
  readonly description: string
  readonly unit?: '%' | 'ATK' | 'STR'
  readonly scope: 'stats' | 'battle' | 'learning' | 'other'
}

const GAME_RULE_LABELS: Readonly<Record<string, GameRuleLabel>> = Object.freeze({
  TwoHandedPAtkFlat: { label: 'Two-handed weapon ATK bonus', description: 'Adds a flat ATK bonus when the two-handed weapon bonus applies.', unit: 'ATK', scope: 'stats' },
  TwoHandedPAtkRate: { label: 'Two-handed weapon ATK scaling', description: "Adds this percentage of the weapon's base ATK to the two-handed bonus.", unit: '%', scope: 'stats' },
  DualWieldPAtkRate: { label: 'Dual Wield ATK multiplier', description: 'Scales ATK when Dual Wield applies.', unit: '%', scope: 'stats' },
  PDmgIncreasesMaxHPAbsorbRate: { label: 'Physical damage converted to max HP', description: 'With the max-HP absorption effect, this percentage of physical ability damage becomes temporary max HP.', unit: '%', scope: 'battle' },
  PDmgIncreasesMaxHPDecayRate: { label: 'Temporary max HP decay', description: 'Removes this percentage of absorbed max HP during the turn decay step.', unit: '%', scope: 'battle' },
  PerfectHitAtChanceOrHigher: { label: 'Perfect Hit threshold', description: 'With Perfect Hit, a hit chance at or above this threshold becomes 100%.', unit: '%', scope: 'battle' },
  PerfectDodgeAtChanceOrLower: { label: 'Perfect Dodge threshold', description: 'With Perfect Dodge, a positive hit chance at or below this threshold becomes 0%.', unit: '%', scope: 'battle' },
  DamageBonusFromAPCostRate: { label: 'AP-cost damage scaling', description: 'Scales the AP spent into a damage bonus when the AP-cost damage effect applies.', unit: '%', scope: 'battle' },
  HealMultiWithPenaltyRate: { label: 'Group-healing penalty', description: 'Reduces healing when an effect turns single-target healing into group healing.', unit: '%', scope: 'battle' },
  TargetSingleWithBonusRate: { label: 'Single-target bonus for group abilities', description: 'Adds a bonus when an effect focuses a group ability on one target.', unit: '%', scope: 'battle' },
  StrWhileUnarmedBonusFlat: { label: 'Unarmed Strength bonus', description: 'Adds STR while both hands are empty and the unarmed Strength effect applies.', unit: 'STR', scope: 'stats' },
  LearnAllJobZeroJPAbilities: { label: 'Learn free abilities from all classes', description: 'Characters automatically learn abilities costing 0 JP from every class, including classes they have not unlocked. Abilities locked by default are excluded.', scope: 'learning' },
})

export function gameRuleLabel(change: GameRuleChange): GameRuleLabel {
  return (Object.hasOwn(GAME_RULE_LABELS, change.field) ? GAME_RULE_LABELS[change.field] : undefined) ?? {
    label: change.field.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
    description: 'This setting is retained from the selected source. Its effect has not been described.',
    scope: change.calculated ? 'stats' : 'other',
  }
}

export function gameRuleValue(value: GameRuleChange['value'], unit?: GameRuleLabel['unit']): string {
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'
  return `${value.toLocaleString()}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`
}

export function gameRuleScope(change: GameRuleChange): string {
  const scope = gameRuleLabel(change).scope
  return scope === 'stats' ? 'Used in resting stat calculations' : scope === 'learning' ? 'Learning rule; recorded learning remains separate' : scope === 'battle' ? 'Battle effect; outside the resting stat preview' : 'Recorded setting; outside the resting stat preview'
}
