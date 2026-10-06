import { type EntityRouteNameResolver } from '../entity-route-names'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { type AppRoute, type Destination, BUILDS_ROUTE } from './types.ts'
import { parseAppRoute, formatAppRoute } from './routes.ts'
import { routeTitle, isRouteWithin, parentRoute, routeDestination } from './hierarchy.ts'
import { navigationState, withNavigationState, NAVIGATION_EVENT, writeRouteHistory } from './history.ts'

export interface NavigationBlocker {
  readonly scope: AppRoute
  readonly matchQuery?: boolean
  readonly blocked: () => boolean
  readonly onBlocked?: (to: AppRoute) => void
  readonly allows?: (to: AppRoute) => boolean
}

export interface NavigationController {
  readonly route: AppRoute
  readonly destination: Destination
  readonly navigate: (route: AppRoute, options?: { readonly replace?: boolean }) => boolean
  readonly close: () => boolean
  readonly href: (route: AppRoute) => string
  readonly registerBlocker: (blocker: NavigationBlocker) => () => void
  readonly hasOpenDraft: () => boolean
}

export function useNavigationController(options: { readonly resolveEntityName?: EntityRouteNameResolver; readonly shouldBlock?: (from: AppRoute, to: AppRoute) => boolean; readonly onBlocked?: (to: AppRoute) => void } = {}): NavigationController {
  const [route, setRoute] = useState(() => typeof window === 'undefined' ? BUILDS_ROUTE : parseAppRoute(window.location.hash))
  const acceptedRef = useRef(route)
  const acceptedIndexRef = useRef(0)
  const pendingReversalRef = useRef<{ readonly index: number; readonly hash: string } | undefined>(undefined)
  const blockersRef = useRef(new Set<NavigationBlocker>())
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    document.title = routeTitle(route)
  }, [route])

  const blocked = useCallback((from: AppRoute, to: AppRoute) => {
    if (optionsRef.current.shouldBlock?.(from, to)) { optionsRef.current.onBlocked?.(to); return true }
    for (const blocker of blockersRef.current) {
      if (!blocker.blocked() || isRouteWithin(to, blocker.scope, blocker.matchQuery) || blocker.allows?.(to)) continue
      blocker.onBlocked?.(to)
      return true
    }
    return false
  }, [])

  const href = useCallback((value: AppRoute) => formatAppRoute(value, optionsRef.current.resolveEntityName), [])

  const accept = useCallback((next: AppRoute) => {
    const canonical = next.legacy ? { ...next, legacy: undefined } : next
    acceptedRef.current = canonical
    setRoute(canonical)
    const canonicalHash = href(canonical)
    // Canonical slugs replace the current URL without adding a history entry or discarding state
    if (canonical.page.page !== 'unresolved' && window.location.hash !== canonicalHash) window.history.replaceState(window.history.state, '', canonicalHash)
  }, [href])

  useEffect(() => {
    const canonicalHash = href(acceptedRef.current)
    if (acceptedRef.current.page.page !== 'unresolved' && window.location.hash !== canonicalHash) window.history.replaceState(window.history.state, '', canonicalHash)
  }, [href, options.resolveEntityName])

  useEffect(() => {
    const existing = navigationState(window.history.state)
    const initialIndex = existing?.index ?? 0
    acceptedIndexRef.current = initialIndex
    if (!existing) window.history.replaceState(withNavigationState(window.history.state, { index: initialIndex }), '', window.location.href)
    if (acceptedRef.current.legacy) accept(acceptedRef.current)
    const restore = (event: Event) => {
      const next = parseAppRoute(window.location.hash)
      const nextHash = href(next)
      const state = navigationState(event instanceof PopStateEvent ? event.state : window.history.state)
      const pending = pendingReversalRef.current
      if (pending) {
        // A blocked traversal produces more events while reversing; accept only the original entry
        if ((state?.index === pending.index || !state) && nextHash === pending.hash) {
          pendingReversalRef.current = undefined
          if (state) acceptedIndexRef.current = state.index
          accept(next)
        }
        return
      }
      if (!next.legacy && nextHash === href(acceptedRef.current)) {
        if (window.location.hash !== nextHash) accept(next)
        if (state) acceptedIndexRef.current = state.index
        return
      }
      if (blocked(acceptedRef.current, next)) {
        // Reverse traversal instead of replacing its URL, preserving the browser's forward/back stack
        const delta = state ? acceptedIndexRef.current - state.index : -1
        pendingReversalRef.current = { index: acceptedIndexRef.current, hash: href(acceptedRef.current) }
        window.history.go(delta || -1)
        return
      }
      if (state) acceptedIndexRef.current = state.index
      else {
        // Manual hash writes have no app index, so mark the newly accepted entry before later reversal
        const inferredIndex = acceptedIndexRef.current + 1
        window.history.replaceState(withNavigationState(window.history.state, { index: inferredIndex }), '', window.location.href)
        acceptedIndexRef.current = inferredIndex
      }
      accept(next)
    }
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    window.addEventListener(NAVIGATION_EVENT, restore)
    return () => {
      window.removeEventListener('popstate', restore)
      window.removeEventListener('hashchange', restore)
      window.removeEventListener(NAVIGATION_EVENT, restore)
    }
  }, [accept, blocked, href])

  const navigate = useCallback((next: AppRoute, navigateOptions?: { readonly replace?: boolean }) => {
    if (blocked(acceptedRef.current, next)) return false
    const replace = navigateOptions?.replace === true
    acceptedIndexRef.current = writeRouteHistory(next, replace, false, optionsRef.current.resolveEntityName)
    accept(next)
    return true
  }, [accept, blocked, href])

  const close = useCallback(() => {
    const currentState = navigationState(window.history.state)
    if (acceptedRef.current.page.page === 'settings' && acceptedRef.current.overlays.length === 0) {
      const returnRoute = currentState?.returnHash ? parseAppRoute(currentState.returnHash) : BUILDS_ROUTE
      if (blocked(acceptedRef.current, returnRoute)) return false
      if (currentState?.returnIndex !== undefined && currentState.returnIndex !== acceptedIndexRef.current) {
        window.history.go(currentState.returnIndex - acceptedIndexRef.current)
        return true
      }
      return navigate(returnRoute, { replace: true })
    }
    const parent = parentRoute(acceptedRef.current)
    if (!parent || blocked(acceptedRef.current, parent)) return false
    if (currentState?.parentHash === href(parent)) { window.history.back(); return true }
    // Directly opened descendants may have no parent entry; replace rather than leave the application
    return navigate(parent, { replace: true })
  }, [blocked, navigate, href])

  const registerBlocker = useCallback((blocker: NavigationBlocker) => {
    blockersRef.current.add(blocker)
    return () => blockersRef.current.delete(blocker)
  }, [])

  const hasOpenDraft = useCallback(() => [...blockersRef.current].some((blocker) => blocker.blocked()), [])

  return useMemo(() => ({ route, destination: routeDestination(route), navigate, close, href, registerBlocker, hasOpenDraft }), [close, navigate, registerBlocker, hasOpenDraft, href, options.resolveEntityName, route])
}
