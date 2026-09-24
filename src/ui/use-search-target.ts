import { useEffect, useRef } from 'react'
import { parseUniversalSearchTarget, type UniversalSearchTarget } from './search-navigation'

export function useSearchTarget(onTarget: (target: UniversalSearchTarget) => void) {
  const onTargetRef = useRef(onTarget)
  onTargetRef.current = onTarget

  useEffect(() => {
    const readTarget = () => {
      const target = parseUniversalSearchTarget(window.location.hash)
      if (target) onTargetRef.current(target)
    }
    readTarget()
    window.addEventListener('hashchange', readTarget)
    window.addEventListener('popstate', readTarget)
    return () => {
      window.removeEventListener('hashchange', readTarget)
      window.removeEventListener('popstate', readTarget)
    }
  }, [])
}
