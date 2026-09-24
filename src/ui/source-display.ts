import { starterSourceLabel } from '../catalog'

export interface SourceDisplay {
  readonly label: string
  readonly detail?: string
}

function urlHost(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

export function sourceDisplay(value: string): SourceDisplay {
  const label = starterSourceLabel(value)
  const host = urlHost(value)
  if (label) return { label, ...(host ? { detail: host } : {}) }
  if (host) return { label: host, detail: value }
  return { label: value }
}
