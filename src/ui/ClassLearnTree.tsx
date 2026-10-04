import { useId } from 'react'
import { bundledTreeIdentity, CLASS_TREE_IDENTITY_SOURCE, classTreeSkill } from '../catalog/class-learn-tree'
import { learningCost } from '../domain/ability-estimates'
import { definitionIconKey } from '../catalog/menu-icons'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, exportedTree, LEARN_NODE_TYPES, type ExportedTreeNode } from '../domain/crystal-edit'
import { learnTreeGraph, treePositionKey, type TreePosition } from '../domain/learn-tree'
import type { CatalogEntity, CatalogSnapshot, PersonalDefinition } from '../domain/types'
import { GameIcon } from './GameIcon'
import { SourceReferences } from './KnowledgeValue'
import { Sources } from './Sources'
import { formatAppRoute } from './navigation'
import { externalSources } from './source-display'

const TREE_LAYOUT = Object.freeze({ columnWidth: 100, rowHeight: 120, nodeHeight: 80, minColumnWidth: 84, maxColumnWidth: 150 })
const point = (position: TreePosition) => ({ x: (position.column + .5) * TREE_LAYOUT.columnWidth, y: position.row * TREE_LAYOUT.rowHeight + TREE_LAYOUT.nodeHeight / 2 })

function connectorPath(from: ExportedTreeNode, to: ExportedTreeNode): string {
  const start = point(from)
  const end = point(to)
  return `M ${start.x} ${start.y + (from.nodeType === LEARN_NODE_TYPES.gate ? 0 : TREE_LAYOUT.nodeHeight / 2)} L ${end.x} ${end.y - (to.nodeType === LEARN_NODE_TYPES.gate ? 0 : TREE_LAYOUT.nodeHeight / 2)}`
}

export function ClassLearnTree({ entity, catalog, sourceEntity }: { entity: CatalogEntity | PersonalDefinition; catalog?: CatalogSnapshot; sourceEntity?: CatalogEntity }) {
  const arrowId = useId().replace(/:/g, '')
  const tree = exportedTree(entity)
  const graph = learnTreeGraph(tree)
  const columns = Math.max(1, ...tree.map(node => node.column + 1))
  const rows = Math.max(1, ...tree.map(node => node.row + 1))
  const width = columns * TREE_LAYOUT.columnWidth
  const height = (rows - 1) * TREE_LAYOUT.rowHeight + TREE_LAYOUT.nodeHeight
  const skills = new Map(graph.nodes.map(node => [treePositionKey(node), classTreeSkill(entity, node, catalog, sourceEntity)]))
  const unresolved = new Set(graph.unresolved.map(treePositionKey))
  const bundled = !entity.fields[CLASS_FIELDS.tree] && bundledTreeIdentity(entity)
  const treeField = entity.fields[CLASS_FIELDS.tree] ?? entity.fields[CRYSTAL_EDIT_FIELDS.tree]
  const recordedSources = [...(treeField?.state === 'known' ? treeField.sources ?? [] : []), ...(bundled ? [CLASS_TREE_IDENTITY_SOURCE] : [])]
  const sources = unresolved.size > 0 || [...skills.values()].some(skill => !skill.definition) ? recordedSources : externalSources(recordedSources)
  const help = <p className="learn-tree-help">All incoming prerequisites must be learned. Follow the arrows to the skills they unlock. Select a named skill to open its reference. LP is the learning cost; this reference does not record character learning.</p>
  if (!graph.nodes.length) return null
  return <details className="class-learn-tree"><summary>Learn tree</summary>
    {sources.length > 0 ? <Sources anchor={help} label={`Sources for ${entity.name} learning`}><SourceReferences includeGameExports sources={sources}/></Sources> : help}
    <div aria-label="Scrollable learn tree" className="learn-tree-scroll" role="group" tabIndex={0}>
      <div className="learn-tree" style={{ height, minWidth: columns * TREE_LAYOUT.minColumnWidth, maxWidth: columns * TREE_LAYOUT.maxColumnWidth }}>
        <svg aria-hidden="true" className="learn-tree__connectors" height={height} preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`} width="100%">
          <defs><marker id={arrowId} markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="currentColor" strokeWidth="1.5"/></marker></defs>
          {graph.connectors.map((edge, index) => <path d={connectorPath(edge.from, edge.to)} data-from={treePositionKey(edge.from)} data-to={treePositionKey(edge.to)} key={index} markerEnd={edge.to.nodeType === LEARN_NODE_TYPES.gate ? undefined : `url(#${arrowId})`}/>)}
        </svg>
        <ol aria-label="Learn tree skills" className="learn-tree__nodes">
          {graph.nodes.map(node => {
            const key = treePositionKey(node)
            const skill = skills.get(key)!
            const prerequisiteNames = [...new Set(graph.edges.filter(edge => treePositionKey(edge.to) === key).map(edge => skills.get(treePositionKey(edge.from))!.name))]
            const requirement = [...(prerequisiteNames.length ? [`Requires all: ${prerequisiteNames.join(' and ')}`] : []), ...(unresolved.has(key) ? ['Prerequisite unknown'] : [])].join('. ')
            const cost = skill.monsterLearned ? 'Monster learning' : skill.jp === undefined ? 'LP unknown' : `${learningCost(skill.jp)?.displayedLp ?? 'Unknown'} LP`
            const iconKey = skill.definition ? definitionIconKey(skill.definition) : skill.kind === 'passive' || skill.kind === 'innate' ? 'skill:passive' : undefined
            const contents = <><span className="learn-tree__type"><GameIcon iconKey={iconKey} placeholderKind={skill.kind}/><small>{skill.kind === 'monsterMagic' ? 'Monster magic' : skill.kind}</small></span><strong>{skill.name}</strong><span className="learn-tree__cost">{cost}</span></>
            const descriptionId = `${arrowId}-${key}`
            const definition = skill.definition
            return <li className={`learn-tree__node learn-tree__node--${skill.kind}${definition ? '' : ' learn-tree__node--unresolved'}`} data-position={key} key={key} style={{ left: `${node.column / columns * 100}%`, top: node.row * TREE_LAYOUT.rowHeight, width: `${100 / columns}%`, height: TREE_LAYOUT.nodeHeight }}>
              {definition && catalog ? <a aria-describedby={requirement ? descriptionId : undefined} className="learn-tree__skill" href={formatAppRoute({ page: { page: 'reference', view: 'detail', ref: { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: definition.id } }, overlays: [], query: {} }, () => definition.name)} title={requirement || undefined}>{contents}</a> : <div aria-describedby={requirement ? descriptionId : undefined} className="learn-tree__skill" title={requirement || undefined}>{contents}</div>}
              {requirement && <span className="learn-tree__requirement" id={descriptionId}>{requirement}</span>}
            </li>
          })}
        </ol>
      </div>
    </div>
    {unresolved.size > 0 && <p className="learn-tree-warning">Some prerequisite cells are missing or unrecognized. Their connections remain unknown.</p>}
  </details>
}
