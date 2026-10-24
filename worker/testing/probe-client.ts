import type { z } from 'zod'

// This helper is imported only by local tests; ordinary browser builds never expose probes
export async function probeJson<T>(baseUrl: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const url = new URL(path, baseUrl)
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') throw new Error('Account probes require loopback')
  // A redirect could forward synthetic bodies outside the validated loopback boundary
  const response = await fetch(url, { ...init, redirect: 'error' })
  if (!response.ok) throw new Error(`Local account probe failed (${response.status})`)
  return schema.parse(await response.json())
}
