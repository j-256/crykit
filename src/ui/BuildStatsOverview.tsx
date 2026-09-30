import { logicalEntityKey } from '../domain'
import { STAT_KEYS } from '../domain/crystal-edit'
import { calculateBuildStats, STAT_LABELS } from '../domain/build-stats'
import { classRatingField } from '../domain/stat-ratings'
import type { BuildRevisionContent, CatalogSnapshot, LocalData, SlotDefinition } from '../domain/types'
import { formatStatRange } from './BuildMechanics'
import { DefinitionArtwork } from './GameIcon'
import { KnowledgeValue } from './KnowledgeValue'
import { resolveEntity } from './model'
import { Icon } from './icons'

export function BuildStatsOverview({ content, slots, localData, catalogs }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[] }) {
  const primary = content.primaryClass ? resolveEntity(localData, catalogs, content.primaryClass) : undefined
  if (!primary) return <section aria-label="Class stats" className="build-stat-overview"><h3><Icon name="character"/>Class stats</h3><p>Choose a primary class to see its stat ratings.</p></section>
  const [field, ratings] = classRatingField(primary)
  const estimate = content.calculation ? calculateBuildStats(content, slots, ref => resolveEntity(localData, catalogs, ref), ref => logicalEntityKey(localData, ref)) : undefined
  return <section aria-label="Class stats" className="build-stat-overview">
    <header><div className="icon-label"><DefinitionArtwork catalogs={catalogs} localData={localData} value={content.primaryClass}/><h3>{primary.name} stat ratings</h3></div><span className="field__hint">Primary class</span></header>
    <KnowledgeValue field={field} value={ratings}/>
    <p className="field__hint">Class ratings describe base-stat scaling and growth. A character's numeric stats also depend on level and growth history.</p>
    {estimate && <details><summary>Planned base & equipped stats · level {content.calculation?.level ?? 'unknown'}</summary><div className="structured-value__table"><table aria-label="Planned build stats"><thead><tr><th>Stat</th><th>Unequipped base</th><th>Supported estimate</th></tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row">{STAT_LABELS[stat]}</th><td>{formatStatRange(estimate.stats[stat].base)}</td><td>{formatStatRange(estimate.stats[stat].value)}</td></tr>)}</tbody></table></div><p className="field__hint">Supported contributions only. Review calculation inputs and excluded effects in Checks & notes.</p></details>}
  </section>
}
