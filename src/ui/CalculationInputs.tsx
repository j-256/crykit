import type { BuildCalculationPlan, CatalogSnapshot, LocalData } from '../domain/types'
import { calculationGenderLabel, type GenderDefinition } from '../domain/calculation-genders'
import { entityName } from './model'

export function CalculationInputs({ plan, localData, catalogs, genders }: { plan: BuildCalculationPlan; localData: LocalData; catalogs: readonly CatalogSnapshot[]; genders?: readonly GenderDefinition[] }) {
  const values = [
    ['Calculation level', plan.level ?? 'Unknown'],
    ['Calculation model', 'PC 1.6.9.0 native rules'],
    ['Calculation gender', calculationGenderLabel(plan, genders)],
    ...[['PC balance mode', plan.pcMode ?? 'standard'], ['Growth allocation', plan.growthMode === 'primary' ? 'Follows primary class' : 'Manual']],
    ...plan.growth.map((row, index) => [`Growth class ${index + 1}`, `${entityName(localData, catalogs, row.classRef, 'Unknown growth class')}: ${row.levels ?? 'Unknown'} levels`]),
    ['Retained custom bonuses (unsupported)', plan.bonuses.join(', ') || 'None selected'],
    ['Statuses', plan.statuses.map(ref => entityName(localData, catalogs, ref)).join(', ') || 'None selected'],
    ['Ability', entityName(localData, catalogs, plan.ability, 'None selected')],
    ['Target evasion', plan.targetEvasion ?? 'Unknown'],
  ]
  return <dl aria-label="Calculation inputs" className="definition-list">{values.map(([label, value]) => <div className="definition-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}
