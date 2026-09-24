import { useEffect, useRef } from 'react'
import { useNavigation } from './navigation'
import { searchTargetForRoute, type UniversalSearchTarget } from './search-navigation'

export function useSearchTarget(onTarget: (target: UniversalSearchTarget) => void) {
  const { route } = useNavigation()
  const onTargetRef = useRef(onTarget)
  const lastTargetRef = useRef<string | undefined>(undefined)
  onTargetRef.current = onTarget

  useEffect(() => {
    const target = searchTargetForRoute(route)
    const key: string | undefined = target ? JSON.stringify(target) : undefined
    if (!target || key === lastTargetRef.current) return
    lastTargetRef.current = key
    onTargetRef.current(target)
  }, [route])
}
