import { createContext, type PropsWithChildren, useContext, useRef, useEffect } from 'react'
import { type NavigationController } from './controller.ts'
import { type AppRoute } from './types.ts'
import { formatAppRoute } from './routes.ts'

const NavigationContext = createContext<NavigationController | undefined>(undefined)

export function NavigationProvider({ controller, children }: PropsWithChildren<{ readonly controller: NavigationController }>) {
  return <NavigationContext.Provider value={controller}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationController {
  const value = useContext(NavigationContext)
  if (!value) throw new Error('NavigationProvider is required')
  return value
}

export function useNavigationBlocker(scope: AppRoute, dirty: boolean | (() => boolean), onBlocked?: (to: AppRoute) => void, allows?: (to: AppRoute) => boolean, matchQuery = false): void {
  const { registerBlocker } = useNavigation()
  const dirtyRef = useRef(dirty)
  const blockedRef = useRef(onBlocked)
  const allowsRef = useRef(allows)
  dirtyRef.current = dirty
  blockedRef.current = onBlocked
  allowsRef.current = allows
  const scopeHash = formatAppRoute(scope)
  // Keep the guard registered for a stable route while callbacks read the latest draft state
  useEffect(() => registerBlocker({ scope, matchQuery, blocked: () => typeof dirtyRef.current === 'function' ? dirtyRef.current() : dirtyRef.current, onBlocked: to => blockedRef.current?.(to), allows: (to) => allowsRef.current?.(to) ?? false }), [registerBlocker, scopeHash, matchQuery])
}
