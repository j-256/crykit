import { useMemo, useState } from 'react'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, growthRatings, STAT_KEYS } from '../domain/crystal-edit'
import { calculateGrowth } from '../domain/growth'
import { PC_LEVEL_CAP } from '../domain/calculation-rules'
import { nativeStatRecord } from '../domain/pc-stats'
import { resolveGameRules } from '../domain/game-rules'
import { modCatalogRevision } from '../domain/mod-layers'
import { CalculationGenderField } from './CalculationGenderField'
import type { CatalogEntity, CatalogSnapshot, EntityRef, PersonalDefinition, BuildCalculationPlan } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { DefinitionPickerField, findDefinitionOption, useDefinitionLibrary } from './definitions'
import { ClassLearnTree } from './ClassLearnTree'
import './class-research.css'

interface AllocationDraft { readonly id: number; readonly ref?: EntityRef; readonly levels: string }

function GrowthCalculator({ entity, definitionRef }: { entity: CatalogEntity | PersonalDefinition; definitionRef: EntityRef }) {
  const { options, localData, catalogs } = useDefinitionLibrary()
  const [level, setLevel] = useState(String(PC_LEVEL_CAP))
  const [rows, setRows] = useState<readonly AllocationDraft[]>([])
  const [gender, setGender] = useState<Pick<BuildCalculationPlan, 'gender' | 'genderSelection'>>({})
  const [nextId, setNextId] = useState(1)
  const resolve = (ref: EntityRef) => findDefinitionOption(options, ref)?.record
  const setup = definitionRef.kind === 'catalog' ? Object.values(localData.gameSetups).find(setup => modCatalogRevision(setup.id) === definitionRef.catalogRevisionId) : undefined
  const rules = useMemo(() => resolveGameRules(setup, catalogs), [setup, catalogs])
  const result = calculateGrowth(level.trim() ? Number(level) : NaN, nativeStatRecord(definitionRef, 'job', resolve, rules.mode), rows.map(row => ({ levels: row.levels.trim() ? Number(row.levels) : NaN, record: row.ref ? nativeStatRecord(row.ref, 'job', resolve, rules.mode) : undefined })), gender.gender, rules, gender.genderSelection)
  const update = (rowId: number, patch: Partial<AllocationDraft>) => setRows(current => current.map(row => row.id === rowId ? { ...row, ...patch } : row))
  const display = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return <div className="stack growth-calculator">
    <p>Calculate native base stats before equipment and innates for <strong>{entity.name}</strong>. Enter the classes used for leveling up.</p>
    <div className="cluster"><Field label="Character level"><input aria-label="Character level" max={PC_LEVEL_CAP} min="1" onChange={event => setLevel(event.target.value)} type="number" value={level}/></Field><Button onClick={() => { setRows([{ id: nextId, levels: level, ref: definitionRef }]); setNextId(nextId + 1) }} tone="secondary">Use {entity.name} for all growth levels</Button></div>
    {rows.map((row, index) => <div className="growth-allocation" key={row.id}>
      <DefinitionPickerField allowedKinds={['class']} label={`Growth class ${index + 1}`} onChange={ref => update(row.id, { ref: ref ?? undefined })} value={row.ref}/>
      <Field label={`Growth levels ${index + 1}`}><input aria-label={`Growth levels ${index + 1}`} min="0" max={PC_LEVEL_CAP} onChange={event => update(row.id, { levels: event.target.value })} type="number" value={row.levels}/></Field>
      <Button onClick={() => setRows(current => current.filter(entry => entry.id !== row.id))} tone="quiet">Remove growth row {index + 1}</Button>
    </div>)}
    <Button onClick={() => { setRows(current => [...current, { id: nextId, levels: '0' }]); setNextId(nextId + 1) }} tone="secondary">Add growth class</Button>
    <CalculationGenderField label="Growth calculation gender" genders={rules.genders} plan={gender} onChange={setGender}/>
    {result.issues.length > 0 && <InlineNotice title="Complete the calculation inputs"><ul>{result.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
    <div className="structured-value__table"><table aria-label="Native base stats"><thead><tr><th>Stat</th><th>Class rating</th><th>Native total</th></tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row">{stat}</th><td>{growthRatings(entity)[stat] ?? 'Unknown'}</td><td>{display(result.stats[stat])}</td></tr>)}</tbody></table></div>
    <p className="field__hint">PC 1.6.9.0 base growth with native integer steps and gender rounding. {setup ? `Gender bonuses and balance mode follow ${setup.label}.` : 'Native gender bonuses and Standard balance records are used for this source preview.'} Unspecified gender shows values without a gender bonus. Excludes gear, innates, passives, and battle effects. Switch and unverified mods are unsupported. These results do not change recorded stats.</p>
  </div>
}

export function ClassResearch({ entity, catalog, definitionRef, sourceEntity }: { entity: CatalogEntity | PersonalDefinition; catalog?: CatalogSnapshot; definitionRef: EntityRef; sourceEntity?: CatalogEntity }) {
  if (entity.kind !== 'class' || !(CLASS_FIELDS.ratings in entity.fields || CLASS_FIELDS.tree in entity.fields || CRYSTAL_EDIT_FIELDS.ratings in entity.fields || CRYSTAL_EDIT_FIELDS.tree in entity.fields)) return null
  return <section aria-label="Class growth and learning" className="panel class-research"><div className="panel__header"><h3>Class growth and learning</h3></div><div className="panel__body stack">
    <details><summary>Growth calculator</summary><GrowthCalculator definitionRef={definitionRef} entity={entity}/></details>
    <ClassLearnTree catalog={catalog} entity={entity} sourceEntity={sourceEntity}/>
  </div></section>
}
