import type { RouteQuery } from './navigation'

export const FIELD_FOCUS_QUERY_KEY = 'focus'

export function fieldFocusQuery(fieldKey: string): RouteQuery {
  return { [FIELD_FOCUS_QUERY_KEY]: [fieldKey] }
}

export function focusFieldElement(fieldKey: string, onFocused?: () => void): () => void {
  const frame = window.requestAnimationFrame(() => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-field-key]')].find(element => element.dataset.fieldKey === fieldKey)
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
    onFocused?.()
  })
  return () => window.cancelAnimationFrame(frame)
}
