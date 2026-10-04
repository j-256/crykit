import { useState } from 'react'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, growthRatings, STAT_KEYS } from '../domain/crystal-edit'
import { calculateGrowth } from '../domain/growth'
import { PC_LEVEL_CAP } from '../domain/calculation-rules'
import { nativeStatRecord } from '../domain/pc-stats'
import { CALCULATION_GENDER_LABELS } from '../domain/calculation-plan'
import type { CatalogEntity, CatalogSnapshot, EntityRef, PersonalDefinition, BuildCalculationPlan } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { DefinitionPickerField, findDefinitionOption, useDefinitionLibrary } from './definitions'
import { ClassLearnTree } from './ClassLearnTree'
import './class-research.css'

interface AllocationDraft { readonly id: number; readonly ref?: EntityRef; readonly levels: string }

function GrowthCalculator({ entity, definitionRef }: { entity: CatalogEntity | PersonalDefinition; definitionRef: EntityRef }) {
  const { options } = useDefinitionLibrary()
  const [level, setLevel] = useState(String(PC_LEVEL_CAP))
  const [rows, setRows] = useState<readonly AllocationDraft[]>([])
  const [gender, setGender] = useState<BuildCalculationPlan['gender']>()
  const [nextId, setNextId] = useState(1)
  const resolve = (ref: EntityRef) => findDefinitionOption(options, ref)?.record
  const result = calculateGrowth(level.trim() ? Number(level) : NaN, nativeStatRecord(definitionRef, 'job', resolve), rows.map(row => ({ levels: row.levels.trim() ? Number(row.levels) : NaN, record: row.ref ? nativeStatRecord(row.ref, 'job', resolve) : undefined })), gender)
  const update = (rowId: number, patch: Partial<AllocationDraft>) => setRows(current => current.map(row => row.id === rowId ? { ...row, ...patch } : row))
  const display = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return <div className="stack growth-calculator">
    <p>Calculate native base stats before equipment and innates for <strong>{entity.name}</strong>. Allocate growth levels explicitly; the primary class does not establish level-up history.</p>
    <div className="cluster"><Field label="Character level"><input aria-label="Character level" max={PC_LEVEL_CAP} min="1" onChange={event => setLevel(event.target.value)} type="number" value={level}/></Field><Button onClick={() => { setRows([{ id: nextId, levels: level, ref: definitionRef }]); setNextId(nextId + 1) }} tone="secondary">Use {entity.name} for all growth levels</Button></div>
    {rows.map((row, index) => <div className="growth-allocation" key={row.id}>
      <DefinitionPickerField allowedKinds={['class']} label={`Growth class ${index + 1}`} onChange={ref => update(row.id, { ref: ref ?? undefined })} value={row.ref}/>
      <Field label={`Growth levels ${index + 1}`}><input aria-label={`Growth levels ${index + 1}`} min="0" max={PC_LEVEL_CAP} onChange={event => update(row.id, { levels: event.target.value })} type="number" value={row.levels}/></Field>
      <Button onClick={() => setRows(current => current.filter(entry => entry.id !== row.id))} tone="quiet">Remove growth row {index + 1}</Button>
    </div>)}
    <Button onClick={() => { setRows(current => [...current, { id: nextId, levels: '0' }]); setNextId(nextId + 1) }} tone="secondary">Add growth class</Button>
    <Field label="Growth calculation gender"><select aria-label="Growth calculation gender" onChange={event => setGender(event.target.value ? event.target.value as BuildCalculationPlan['gender'] : undefined)} value={gender ?? ''}><option value="">Not specified (no bonus preview)</option>{Object.entries(CALCULATION_GENDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    {result.issues.length > 0 && <InlineNotice title="Complete the calculation inputs"><ul>{result.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
    <div className="structured-value__table"><table aria-label="Native base stats"><thead><tr><th>Stat</th><th>Class rating</th><th>Native total</th></tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row">{stat}</th><td>{growthRatings(entity)[stat] ?? 'Unknown'}</td><td>{display(result.stats[stat])}</td></tr>)}</tbody></table></div>
    <p className="field__hint">PC 1.6.9.0 base growth with native integer steps and gender rounding. Male and female totals include the game's gender bonuses. An unspecified gender provides a no-bonus comparison baseline. No equipment, innates, passives, or battle effects. Standard balance records are used; Switch and unverified mod inputs remain unsupported. Nothing is saved as an observed character stat.</p>
  </div>
}

export function ClassResearch({ entity, catalog, definitionRef, sourceEntity }: { entity: CatalogEntity | PersonalDefinition; catalog?: CatalogSnapshot; definitionRef: EntityRef; sourceEntity?: CatalogEntity }) {
  if (entity.kind !== 'class' || !(CLASS_FIELDS.ratings in entity.fields || CLASS_FIELDS.tree in entity.fields || CRYSTAL_EDIT_FIELDS.ratings in entity.fields || CRYSTAL_EDIT_FIELDS.tree in entity.fields)) return null
  return <section aria-label="Class growth and learning" className="panel class-research"><div className="panel__header"><h3>Class growth and learning</h3></div><div className="panel__body stack">
    <details><summary>Growth calculator</summary><GrowthCalculator definitionRef={definitionRef} entity={entity}/></details>
    <ClassLearnTree catalog={catalog} entity={entity} sourceEntity={sourceEntity}/>
  </div></section>
}
