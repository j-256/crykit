import type { AbilityEstimate } from '../domain/ability-estimates'
import type { MechanicsDefinition } from '../domain/mechanics-facts'
import { nativeInteger } from '../domain/native-number'
import type { NativeRecord } from '../domain/native-stat-record'
import { SourceReferences } from './KnowledgeValue'
import { Sources } from './Sources'
import { Icon } from './icons'
import './ability-formula-reference.css'

const ATTRIBUTE_RATES = Object.freeze({ STR: 'StrRate', VIT: 'VitRate', DEX: 'DexRate', AGI: 'AgiRate', MND: 'MndRate', SPI: 'SpiRate', SPD: 'SpdRate', LUK: 'LckRate' })
const formatNumber = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })
const sourceNumber = (value: unknown, suffix = '') => nativeInteger(value) ? `${formatNumber(value)}${suffix}` : 'Unknown'

function inheritedNumber(record: NativeRecord | undefined, field: string, inheritedField: string, label: string, suffix = ''): string {
  return record?.[field] === null ? `Inherits ${label} (${sourceNumber(record[inheritedField], suffix)})` : sourceNumber(record?.[field], suffix)
}

export function AbilityFormulaReference({ ability, abilityName, definition, numericRecord }: { ability: AbilityEstimate; abilityName: string; definition?: MechanicsDefinition; numericRecord?: NativeRecord }) {
  const power = ability.baseAmount
  const formattedPower = !power ? 'Unknown' : power.low === power.high ? formatNumber(power.low) : `${formatNumber(power.low)} to ${formatNumber(power.high)}`
  const attackStat = typeof numericRecord?.PDefAsPAtk === 'boolean' ? numericRecord.PDefAsPAtk ? 'DEF' : 'ATK' : 'Unknown'
  return <section aria-label="Ability estimate" className="ability-formula">
    <header className="ability-formula__heading">
      <h4>{abilityName}</h4>
      {definition && <Sources label="Ability formula sources"><SourceReferences includeGameExports sources={definition.sources}/></Sources>}
    </header>
    <div className="ability-formula__overview">
      <dl className="ability-formula__power">
        <div>
          <dt><Icon name="layers"/>Power coefficient</dt>
          <dd data-state={power ? 'known' : 'unknown'}>{formattedPower}</dd>
        </div>
      </dl>
      <div className="ability-formula__learning">
        <h5><Icon name="book"/>Learning cost</h5>
        <dl>
          <div><dt>JP</dt><dd>{ability.learning ? formatNumber(ability.learning.jp) : 'Unknown'}</dd></div>
          <div><dt>Displayed LP</dt><dd>{ability.learning ? formatNumber(ability.learning.displayedLp) : 'Unknown'}</dd></div>
          <div><dt>Whole LP needed</dt><dd>{ability.learning ? formatNumber(ability.learning.requiredWholeLp) : 'Unknown'}</dd></div>
        </dl>
      </div>
    </div>
    <p className="ability-formula__scope">Uses Build stats before contextual power, resource-based effects, target defense, critical hits, and variance. Negative power represents healing.</p>
    {ability.notes.length > 0 && <ul className="ability-formula__notes">{ability.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    <details className="ability-formula__inputs">
      <summary>Source formula inputs</summary>
      <p className="ability-formula__equation"><span>Base term</span><span>+</span><span>Attribute contributions</span><span>=</span><strong>Power coefficient</strong></p>
      <div className="ability-formula__groups">
        <section aria-label="Base term inputs">
          <h5>Base term</h5>
          <dl>
            <div><dt>Base power</dt><dd>{sourceNumber(numericRecord?.BasePower)}</dd></div>
            <div><dt>Attack rate</dt><dd>{sourceNumber(numericRecord?.BasePAtkRate, '%')}</dd></div>
            <div><dt>Attack stat</dt><dd>{attackStat}</dd></div>
          </dl>
        </section>
        <section aria-label="Scaling term inputs">
          <h5>Scaling term</h5>
          <dl>
            <div><dt>Scaling power</dt><dd>{inheritedNumber(numericRecord, 'ScalingPower', 'BasePower', 'base power')}</dd></div>
            <div><dt>Scaling attack rate</dt><dd>{inheritedNumber(numericRecord, 'ScalingPAtkRate', 'BasePAtkRate', 'attack rate', '%')}</dd></div>
          </dl>
        </section>
        <section aria-label="Attribute rate inputs">
          <h5>Attribute rates</h5>
          <dl className="ability-formula__attributes">
            {Object.entries(ATTRIBUTE_RATES).map(([label, key]) => <div data-state={numericRecord?.[key] === 0 ? 'zero' : 'active'} key={key}><dt>{label}</dt><dd>{sourceNumber(numericRecord?.[key], '%')}</dd></div>)}
          </dl>
        </section>
      </div>
      <div className="ability-formula__method">
        <p>Base and scaling terms each add attack multiplied by their attack rate, divided by 100.</p>
        <p>Each attribute contributes its stat multiplied by its rate, divided by 100, then multiplied by the scaling term and divided by 100. Each division in this coefficient stage truncates toward zero.</p>
        <p>Contextual bonus power is zero in this reference. Learning costs do not establish that the Build can learn or use the ability.</p>
      </div>
    </details>
  </section>
}
