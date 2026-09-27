import { useId, useState } from 'react'
import { CRYSTAL_EDIT_FIELDS, exportedTree, growthRatings, LEARN_NODE_TYPES, MAX_TREE_COLUMNS, STAT_KEYS, type GrowthStat } from '../domain/crystal-edit'
import { estimateGrowth, GUIDE_GROWTH_SOURCE, GUIDE_LEVEL_CAP } from '../domain/growth'
import type { CatalogEntity, CatalogSnapshot, EntityRef } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { DefinitionPickerField, findDefinitionOption, useDefinitionWorkspace } from './definitions'
import { SourceSummary } from './KnowledgeValue'
import './class-research.css'

interface AllocationDraft { readonly id: number; readonly ref?: EntityRef; readonly levels: string }

function GrowthCalculator({ entity, catalog }: { entity: CatalogEntity; catalog: CatalogSnapshot }) {
  const { options } = useDefinitionWorkspace()
  const id = useId()
  const [level, setLevel] = useState(String(GUIDE_LEVEL_CAP))
  const [rows, setRows] = useState<readonly AllocationDraft[]>([])
  const [bonuses, setBonuses] = useState<readonly GrowthStat[]>([])
  const [nextId, setNextId] = useState(1)
  const result = estimateGrowth(level.trim() ? Number(level) : NaN, growthRatings(entity), rows.map(row => ({ levels: row.levels.trim() ? Number(row.levels) : NaN, ratings: growthRatings(findDefinitionOption(options, row.ref)?.record ?? { fields: {} }) })), bonuses)
  const update = (rowId: number, patch: Partial<AllocationDraft>) => setRows(current => current.map(row => row.id === rowId ? { ...row, ...patch } : row))
  const display = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  return <div className="stack growth-calculator">
    <p>Estimate unequipped base stats for <strong>{entity.name}</strong>. Allocate growth levels explicitly; the primary class does not establish level-up history.</p>
    <div className="cluster"><Field label="Character level"><input aria-label="Character level" max={GUIDE_LEVEL_CAP} min="1" onChange={event => setLevel(event.target.value)} type="number" value={level}/></Field><Button onClick={() => { setRows([{ id: nextId, levels: level, ref: { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id } }]); setNextId(nextId + 1) }} tone="secondary">Use {entity.name} for all growth levels</Button></div>
    {rows.map((row, index) => <div className="growth-allocation" key={row.id}>
      <DefinitionPickerField allowedKinds={['class']} label={`Growth class ${index + 1}`} onChange={ref => update(row.id, { ref: ref ?? undefined })} value={row.ref}/>
      <Field label={`Growth levels ${index + 1}`}><input aria-label={`Growth levels ${index + 1}`} min="0" max={GUIDE_LEVEL_CAP} onChange={event => update(row.id, { levels: event.target.value })} type="number" value={row.levels}/></Field>
      <Button onClick={() => setRows(current => current.filter(entry => entry.id !== row.id))} tone="quiet">Remove growth row {index + 1}</Button>
    </div>)}
    <Button onClick={() => { setRows(current => [...current, { id: nextId, levels: '0' }]); setNextId(nextId + 1) }} tone="secondary">Add growth class</Button>
    <details><summary>Optional stat bonuses</summary><p>Toggle only bonuses you want to model. These apply the guide's per-stat gender-bonus equations without inferring bonuses from appearance.</p><div className="cluster">{STAT_KEYS.map(stat => <label className="check-row" htmlFor={`${id}-${stat}`} key={stat}><input checked={bonuses.includes(stat)} id={`${id}-${stat}`} onChange={event => setBonuses(current => event.target.checked ? [...current, stat] : current.filter(value => value !== stat))} type="checkbox"/>{stat}</label>)}</div></details>
    {result.issues.length > 0 && <InlineNotice title="Complete the calculation inputs"><ul>{result.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
    <div className="structured-value__table"><table aria-label="Estimated base stats"><thead><tr><th>Stat</th><th>Class rating</th><th>Estimate</th></tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row">{stat}</th><td>{growthRatings(entity)[stat] ?? 'Unknown'}</td><td>{display(result.stats[stat].value)}</td></tr>)}</tbody></table></div>
    <details><summary>Formula breakdown and scope</summary><p>Guide estimates retain fractional values; the table displays up to three decimal places. Equipment, passives, statuses, and other mod effects are excluded. Nothing is saved as an observed character stat.</p><div className="structured-value__table"><table aria-label="Growth formula breakdown"><thead><tr><th>Stat</th><th>Base</th><th>Level</th><th>Growth</th><th>Bonus</th></tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row">{stat}</th>{(['base', 'level', 'growth', 'bonus'] as const).map(part => <td key={part}>{display(result.stats[stat][part])}</td>)}</tr>)}</tbody></table></div><SourceSummary source={GUIDE_GROWTH_SOURCE}/></details>
  </div>
}

export function ClassResearch({ entity, catalog }: { entity: CatalogEntity; catalog: CatalogSnapshot }) {
  if (entity.kind !== 'class' || !(CRYSTAL_EDIT_FIELDS.ratings in entity.fields || CRYSTAL_EDIT_FIELDS.tree in entity.fields)) return null
  const nodes = exportedTree(entity)
  const columns = Math.min(MAX_TREE_COLUMNS, Math.max(1, ...nodes.map(node => node.column + 1)))
  const sorted = [...nodes].sort((a, b) => a.row - b.row || a.column - b.column)
  return <section aria-label="Class growth and learning" className="panel class-research"><div className="panel__header"><h3>Class growth and learning</h3></div><div className="panel__body stack">
    <details><summary>Growth calculator</summary><GrowthCalculator catalog={catalog} entity={entity}/></details>
    {nodes.length > 0 && <details><summary>Exported learn tree</summary><p>Tree positions and prerequisite connectors from the class export. Numbered abilities and passives need their definitions from the same game data. This tree does not record anyone's learning or change the confirmed Switch maps.</p><div className="export-tree-scroll"><ol aria-label="Exported learn tree nodes" className="export-tree" style={{ gridTemplateColumns: `repeat(${columns}, minmax(68px, 1fr))` }}>{sorted.map(node => {
      const family = node.nodeType === LEARN_NODE_TYPES.ability ? 'Abilities' : 'Passives'
      const definition = catalog.entities[`crystal-edit:${family}:${node.dataId}`]
      const label = node.nodeType === LEARN_NODE_TYPES.blank ? 'Empty' : node.nodeType === LEARN_NODE_TYPES.gate ? 'Gate' : node.nodeType === LEARN_NODE_TYPES.ability ? definition?.name ?? `Ability #${node.dataId}` : node.nodeType === LEARN_NODE_TYPES.passive ? definition?.name ?? `Passive #${node.dataId}` : `Node type ${node.nodeType}`
      return <li className={`export-tree__node export-tree__node--${node.nodeType}`} key={`${node.row}:${node.column}`} style={{ gridRow: node.row + 1, gridColumn: node.column + 1 }}><small>R{node.row + 1} C{node.column + 1}</small><strong>{label}</strong>{node.prerequisites.length > 0 && <small>Requires {node.prerequisites.map(p => `R${p.row + 1} C${p.column + 1}`).join(', ')}</small>}</li>
    })}</ol></div></details>}
  </div></section>
}
