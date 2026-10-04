import { calculationGenderLabel, calculationGenderValue, genderOptionValue, selectCalculationGender, type GenderDefinition } from '../domain/calculation-genders'
import type { BuildCalculationPlan } from '../domain/types'
import { Field } from './components'

export function CalculationGenderField<Plan extends Pick<BuildCalculationPlan, 'gender' | 'genderSelection'>>({ label = 'Calculation gender', plan, genders, onChange }: { label?: string; plan: Plan; genders: readonly GenderDefinition[]; onChange: (plan: Plan) => void }) {
  const value = calculationGenderValue(plan)
  const options = genders.map(gender => ({ value: genderOptionValue(gender.id), label: gender.name }))
  const selected = options.some(option => option.value === value)
  return <Field label={label}><select aria-label={label} onChange={event => onChange(selectCalculationGender(plan, event.target.value))} value={value}><option value="">Not specified (no bonus preview)</option>{value && !selected && <option value={value}>{calculationGenderLabel(plan, genders)}</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
}
