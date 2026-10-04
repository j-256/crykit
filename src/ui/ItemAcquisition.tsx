import { useMemo, type ReactNode } from 'react'
import { projectAcquisitionGuidance } from '../catalog/acquisition-guidance'
import { nativeGardening } from '../catalog/native-gardening'
import { type AcquisitionKind, type AcquisitionMaterial, type AcquisitionRoute } from '../domain/item-acquisition'
import { nativeIdentity } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, EntityRef } from '../domain/types'
import { NavigationLink } from './NavigationLink'
import { useNavigation } from './navigation'
import { routeForSearchTarget } from './search-navigation'
import { Money } from './MoneyText'
import { Sources } from './Sources'
import { acquisitionMode, ACQUISITION_MODES as MODES, ACQUISITION_MODE_QUERY as MODE_QUERY } from './acquisition-mode'

const GROUPS: readonly { readonly kind: AcquisitionKind; readonly title: string }[] = Object.freeze([
  { kind: 'shop', title: 'Buy' }, { kind: 'chest', title: 'Find in a chest' }, { kind: 'drop', title: 'Monster drops' }, { kind: 'steal', title: 'Steal' }, { kind: 'craft', title: 'Craft' }, { kind: 'reward', title: 'Rewards & trades' }, { kind: 'start', title: 'Starting inventory' }, { kind: 'recovery', title: 'Lost & Found recovery' },
])

function AcquisitionLink({ definitionRef, onOpenDefinition, children }: { definitionRef: EntityRef; onOpenDefinition: (ref: EntityRef) => void; children: ReactNode }) {
  const navigation = useNavigation()
  return <NavigationLink className="button button--quiet" route={{ ...routeForSearchTarget({ kind: 'definition', ref: definitionRef }), query: navigation.route.query }} onNavigate={() => onOpenDefinition(definitionRef)}>{children}</NavigationLink>
}

function Materials({ items, onOpenDefinition }: { items: readonly AcquisitionMaterial[]; onOpenDefinition: (ref: EntityRef) => void }) {
  return <ul className="acquisition-materials">{items.map((item, index) => <li key={index}><span>{item.count} × </span>{item.ref ? <AcquisitionLink definitionRef={item.ref} onOpenDefinition={onOpenDefinition}>{item.name}</AcquisitionLink> : item.name}</li>)}</ul>
}

function Route({ route, onOpenDefinition }: { route: AcquisitionRoute; onOpenDefinition: (ref: EntityRef) => void }) {
  return <li className="acquisition-route">
    <div className="acquisition-route__title">{route.ref ? <AcquisitionLink definitionRef={route.ref} onOpenDefinition={onOpenDefinition}>{route.label}</AcquisitionLink> : <strong>{route.label}</strong>}{route.station && <span>at {route.station}</span>}{route.location && <span className="acquisition-location">{route.location}</span>}<Sources label={`Sources for ${route.label} acquisition`}>{route.coord && <p>World coordinates: X {route.coord.X}, Y {route.coord.Y}, Z {route.coord.Z}</p>}<p>{route.evidence}</p></Sources></div>
    <div className="acquisition-route__facts">{route.price !== undefined && <span>Price: <Money copper={route.price}/></span>}{route.quantity !== undefined && <span>Quantity: {route.quantity}</span>}{route.chance !== undefined && <span>{route.kind === 'steal' ? 'Availability' : 'Base drop chance'}: {route.chance}%</span>}{route.success !== undefined && <span>Steal success per attempt: {route.success}%</span>}</div>
    {route.ingredients.length > 0 && <div><p className="acquisition-caption">Ingredients</p><Materials items={route.ingredients} onOpenDefinition={onOpenDefinition}/></div>}
    {route.costs.length > 0 && <div><p className="acquisition-caption">Trade inputs</p><Materials items={route.costs} onOpenDefinition={onOpenDefinition}/></div>}
    {route.requirements.length > 0 && <div><p className="acquisition-caption">Required items</p><Materials items={route.requirements} onOpenDefinition={onOpenDefinition}/></div>}
    {route.conditions.length > 0 && <ul className="acquisition-conditions">{route.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul>}
    {route.kind === 'recovery' && <p className="acquisition-note">Conditional recovery stock; this may require an earlier acquisition or save state.</p>}
  </li>
}

export function ItemAcquisition({ catalog, entity, onOpenDefinition }: { catalog: CatalogSnapshot; entity: CatalogEntity; onOpenDefinition: (ref: EntityRef) => void }) {
  const identity = nativeIdentity(entity)
  const navigation = useNavigation()
  const requestedMode = navigation.route.query[MODE_QUERY]?.[0]
  const mode = acquisitionMode(entity, requestedMode)
  const nativeMode = mode?.native ?? 'unresolved'
  const projection = useMemo(() => projectAcquisitionGuidance(catalog, entity, nativeMode), [catalog, entity, nativeMode])
  const result = projection.acquisition
  const gardening = useMemo(() => nativeMode === 'base' ? nativeGardening(catalog, entity) : undefined, [catalog, entity, nativeMode])
  if (entity.kind !== 'item') return null
  return <section aria-label="How to obtain" className="panel item-acquisition">
    <div className="panel__header"><h3>How to obtain</h3>{identity && <label className="acquisition-mode"><span>Game mode</span><select onChange={event => navigation.navigate({ ...navigation.route, query: { ...navigation.route.query, [MODE_QUERY]: [event.target.value] } }, { replace: true })} value={mode?.value ?? ''}>{!mode && <option value="">Choose game mode</option>}{MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}</div>
    <div className="panel__body stack">
      {result.routes.length === 0 && <p>No acquisition route found in the indexed sources. This does not establish that this item is unobtainable.</p>}
      {GROUPS.map(group => {
        const routes = result.routes.filter(route => route.kind === group.kind)
        return routes.length > 0 && <div className="acquisition-group" key={group.kind}><h4>{group.title}</h4><ul className="acquisition-routes">{routes.map((route, index) => <Route key={`${route.evidence}:${index}`} route={route} onOpenDefinition={onOpenDefinition}/>)}</ul></div>
      })}
      {gardening && <div className="acquisition-group"><div className="cluster"><h4>Growing this seed</h4><Sources label={`Sources for growing ${entity.name}`}>{gardening.evidence.map(evidence => <p key={evidence}>{evidence}</p>)}</Sources></div><p>Sprouts after {gardening.minutes} {gardening.minutes === 1 ? 'minute' : 'minutes'} of play time. {gardening.wateringReductionMinutes > 0 ? `Watering once moves the sprout time earlier by ${gardening.wateringReductionMinutes} minutes.` : 'Watering does not shorten this seed\'s growth time.'}</p><p>Harvesting starts a battle with {gardening.encounters.map((encounter, index) => <span key={encounter.ref.entityId}>{index > 0 && ', '}<AcquisitionLink definitionRef={encounter.ref} onOpenDefinition={onOpenDefinition}>{encounter.name}</AcquisitionLink></span>)}.</p></div>}
      {result.unresolved.map(note => <p className="acquisition-note" key={note}>{note}</p>)}
    </div>
  </section>
}
