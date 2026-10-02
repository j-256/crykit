import type { AnchorHTMLAttributes, PropsWithChildren } from 'react'
import type { EntityRef } from '../domain/types'
import { useNavigation, type AppRoute } from './navigation'
import { routeForSearchTarget } from './search-navigation'

export function NavigationLink({ route, onNavigate, children, ...props }: PropsWithChildren<Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & { route: AppRoute; onNavigate: () => void }>) {
  const { href } = useNavigation()
  return <a {...props} href={href(route)} onClick={event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target && props.target !== '_self') return
    event.preventDefault()
    onNavigate()
  }}>{children}</a>
}

export function DefinitionLink({ definitionRef, onOpenDefinition, className = '', ...props }: PropsWithChildren<Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & { definitionRef: EntityRef; onOpenDefinition: (ref: EntityRef) => void }>) {
  return <NavigationLink {...props} className={`button button--quiet ${className}`} route={routeForSearchTarget({ kind: 'definition', ref: definitionRef })} onNavigate={() => onOpenDefinition(definitionRef)}/>
}
