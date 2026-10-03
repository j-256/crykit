import { useMemo, type ReactNode } from 'react'
import worldJson from '../catalog/world-acquisition-v1.json' with { type: 'json' }
import { itemAcquisition, type AcquisitionKind, type AcquisitionMaterial, type AcquisitionRoute, type WorldAcquisitionSnapshot } from '../domain/item-acquisition'
import { nativeIdentity } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, EntityRef } from '../domain/types'
import { NavigationLink } from './NavigationLink'
import { useNavigation } from './navigation'
import { routeForSearchTarget } from './search-navigation'
import { Money } from './MoneyText'

const WORLD = worldJson as WorldAcquisitionSnapshot
const GROUPS: readonly { readonly kind: AcquisitionKind; readonly title: string }[] = Object.freeze([
  { kind: 'shop', title: 'Buy' }, { kind: 'chest', title: 'Find in a chest' }, { kind: 'drop', title: 'Monster drops' }, { kind: 'steal', title: 'Steal' }, { kind: 'craft', title: 'Craft' }, { kind: 'reward', title: 'Rewards & trades' }, { kind: 'start', title: 'Starting inventory' }, { kind: 'recovery', title: 'Lost & Found recovery' },
])
const MODE_QUERY = 'mode'
const MODES = Object.freeze([{ value: 'standard', native: 'base', label: 'Standard' }, { value: 'vanilla', native: 'Vanilla', label: 'Vanilla' }, { value: 'chaos', native: 'Chaos', label: 'Chaos' }])

function AcquisitionLink({ definitionRef, onOpenDefinition, children }: { definitionRef: EntityRef; onOpenDefinition: (ref: EntityRef) => void; children: ReactNode }) {
  const navigation = useNavigation()
  return <NavigationLink className="button button--quiet" route={{ ...routeForSearchTarget({ kind: 'definition', ref: definitionRef }), query: navigation.route.query }} onNavigate={() => onOpenDefinition(definitionRef)}>{children}</NavigationLink>
}

function Materials({ items, onOpenDefinition }: { items: readonly AcquisitionMaterial[]; onOpenDefinition: (ref: EntityRef) => void }) {
  return <ul className="acquisition-materials">{items.map((item, index) => <li key={index}><span>{item.count} × </span>{item.ref ? <AcquisitionLink definitionRef={item.ref} onOpenDefinition={onOpenDefinition}>{item.name}</AcquisitionLink> : item.name}</li>)}</ul>
}

function Route({ route, onOpenDefinition }: { route: AcquisitionRoute; onOpenDefinition: (ref: EntityRef) => void }) {
  return <li className="acquisition-route">
    <div className="acquisition-route__title">{route.ref ? <AcquisitionLink definitionRef={route.ref} onOpenDefinition={onOpenDefinition}>{route.label}</AcquisitionLink> : <strong>{route.label}</strong>}{route.station && <span>at {route.station}</span>}{route.location && <span className="acquisition-location">{route.location}</span>}</div>
    <div className="acquisition-route__facts">{route.price !== undefined && <span>Price: <Money copper={route.price}/></span>}{route.quantity !== undefined && <span>Quantity: {route.quantity}</span>}{route.chance !== undefined && <span>{route.kind === 'steal' ? 'Availability' : 'Base drop chance'}: {route.chance}%</span>}{route.success !== undefined && <span>Steal success per attempt: {route.success}%</span>}</div>
    {route.ingredients.length > 0 && <div><p className="acquisition-caption">Ingredients</p><Materials items={route.ingredients} onOpenDefinition={onOpenDefinition}/></div>}
    {route.costs.length > 0 && <div><p className="acquisition-caption">Trade inputs</p><Materials items={route.costs} onOpenDefinition={onOpenDefinition}/></div>}
    {route.requirements.length > 0 && <div><p className="acquisition-caption">Required items</p><Materials items={route.requirements} onOpenDefinition={onOpenDefinition}/></div>}
    {route.conditions.length > 0 && <ul className="acquisition-conditions">{route.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul>}
    {route.kind === 'recovery' && <p className="acquisition-note">Conditional recovery stock; this may require an earlier acquisition or save state.</p>}
    <details className="acquisition-evidence"><summary>Location & source details</summary>{route.coord && <p>World coordinates: X {route.coord.X}, Y {route.coord.Y}, Z {route.coord.Z}</p>}<p>{route.evidence}</p></details>
  </li>
}

export function ItemAcquisition({ catalog, entity, onOpenDefinition }: { catalog: CatalogSnapshot; entity: CatalogEntity; onOpenDefinition: (ref: EntityRef) => void }) {
  const identity = nativeIdentity(entity)
  const navigation = useNavigation()
  const requestedMode = navigation.route.query[MODE_QUERY]?.[0]
  const mode = MODES.find(option => requestedMode === undefined ? option.native === (identity?.mode ?? 'base') : option.value === requestedMode)
  const nativeMode = mode?.native ?? 'unresolved'
  const result = useMemo(() => itemAcquisition(catalog, entity, WORLD, nativeMode), [catalog, entity, nativeMode])
  if (entity.kind !== 'item') return null
  return <section aria-label="How to obtain" className="panel item-acquisition">
    <div className="panel__header"><h3>How to obtain</h3>{identity && <label className="acquisition-mode"><span>Game mode</span><select onChange={event => navigation.navigate({ ...navigation.route, query: { ...navigation.route.query, [MODE_QUERY]: [event.target.value] } }, { replace: true })} value={mode?.value ?? ''}>{!mode && <option value="">Choose game mode</option>}{MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}</div>
    <div className="panel__body stack">
      {result.routes.length === 0 && <p>No acquisition route found in the indexed sources. This does not establish that this item is unobtainable.</p>}
      {GROUPS.map(group => {
        const routes = result.routes.filter(route => route.kind === group.kind)
        return routes.length > 0 && <div className="acquisition-group" key={group.kind}><h4>{group.title}</h4><ul className="acquisition-routes">{routes.map((route, index) => <Route key={`${route.evidence}:${index}`} route={route} onOpenDefinition={onOpenDefinition}/>)}</ul></div>
      })}
      {result.guides.length > 0 && <p>Additional acquisition guidance is recorded in Definition facts below.</p>}
      {result.unresolved.map(note => <p className="acquisition-note" key={note}>{note}</p>)}
      {result.routes.length > 0 && <p className="acquisition-note">Routes describe the selected reference source and game mode. Story conditions, mods, and randomizers can change availability.</p>}
    </div>
  </section>
}
