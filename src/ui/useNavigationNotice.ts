import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export function useNavigationNotice(): { readonly noticeRef: RefObject<HTMLDivElement | null>; readonly revealNotice: () => void } {
  const noticeRef = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  // A repeated blocked attempt must reveal the same message even when its text has not changed
  const revealNotice = useCallback(() => setAttempt(value => value + 1), [])
  useLayoutEffect(() => {
    if (attempt === 0) return
    const notice = noticeRef.current
    if (!notice) return
    const reveal = () => {
      // Open containing disclosures before focus so recovery choices are available to keyboard users
      for (let parent = notice.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
      }
      notice.focus({ preventScroll: true })
      notice.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    }
    reveal()
    let frame: number | undefined
    const replayAfterHistory = () => {
      if (!notice.isConnected || document.activeElement !== notice) return
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      // Native history reversal restores old scroll after layout effects; replay only while feedback keeps focus
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        if (notice.isConnected && document.activeElement === notice) reveal()
      })
    }
    window.addEventListener('popstate', replayAfterHistory)
    window.addEventListener('hashchange', replayAfterHistory)
    return () => {
      window.removeEventListener('popstate', replayAfterHistory)
      window.removeEventListener('hashchange', replayAfterHistory)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [attempt])
  return { noticeRef, revealNotice }
}
