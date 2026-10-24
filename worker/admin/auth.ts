import { createLocalJWKSet, jwtVerify, errors, type JSONWebKeySet } from 'jose'
import { z } from 'zod'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'

export const adminLimits = Object.freeze({
  sessionMs: 3_600_000,
  confirmationMs: 900_000,
  jwksMs: 300_000,
  refreshMs: 30_000,
  fetchMs: 3_000,
  jwksBytes: 65_536,
  jwtCharacters: 16_384,
  issuers: 8,
})
const configSchema = z.strictObject({
  version: z.literal(1),
  issuer: z.string().url().max(256),
  jwksUrl: z.string().url().max(512),
  adminAudience: z.string().min(1).max(256),
  confirmationAudience: z.string().min(1).max(256),
  confirmationEnabled: z.boolean(),
})
export function adminConfig(context: ServiceContext) {
  try {
    const config = configSchema.parse(JSON.parse(context.env.ADMIN_ACCESS_CONFIG ?? ''))
    const issuer = new URL(config.issuer)
    // The trusted key endpoint is deployment configuration, never a JWT jku/x5u/iss lookup
    if (
      issuer.protocol !== 'https:' ||
      issuer.origin !== config.issuer ||
      config.jwksUrl !== `${config.issuer}/cdn-cgi/access/certs` ||
      config.adminAudience === config.confirmationAudience
    )
      throw new Error('Invalid admin configuration')
    return config
  } catch {
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
}
export interface AccessIdentity {
  readonly issuer: string
  readonly subject: string
  readonly email: string
  readonly tokenExpiresAt: number
  readonly audience: string
}
// Private bootstrap accepts only an identity actually produced by this verifier
const verifiedIdentities = new WeakSet<AccessIdentity>()
export function assertVerifiedIdentity(identity: AccessIdentity, context: ServiceContext): void {
  const config = adminConfig(context)
  if (
    !verifiedIdentities.has(identity) ||
    identity.issuer !== config.issuer ||
    identity.audience !== config.adminAudience ||
    identity.tokenExpiresAt <= context.now()
  )
    throw new ApiFailure('FORBIDDEN')
}
interface KeyCache {
  resolver?: ReturnType<typeof createLocalJWKSet>
  expiresAt: number
  attemptedAt: number
  pending?: Promise<void>
}
const caches = new Map<string, KeyCache>()
async function refreshKeys(url: string, cache: KeyCache, context: ServiceContext): Promise<void> {
  if (cache.pending) return cache.pending
  if (context.now() - cache.attemptedAt < adminLimits.refreshMs) throw new ApiFailure('AUTH_FAILED')
  cache.attemptedAt = context.now()
  cache.pending = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), adminLimits.fetchMs)
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (response.status !== 200 || !response.body) throw new Error('Key fetch failed')
      const reader = response.body.getReader()
      let size = 0
      const parts: Uint8Array[] = []
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > adminLimits.jwksBytes) {
            await reader.cancel()
            throw new Error('Key response too large')
          }
          parts.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.length
      }
      const keys: JSONWebKeySet = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
      if (!Array.isArray(keys.keys) || keys.keys.length === 0 || keys.keys.length > 16) throw new Error('Invalid keys')
      cache.resolver = createLocalJWKSet(keys)
      cache.expiresAt = context.now() + adminLimits.jwksMs
    } finally {
      clearTimeout(timer)
    }
  })().finally(() => {
    cache.pending = undefined
  })
  return cache.pending
}
export async function verifyAccessIdentity(
  request: Request,
  context: ServiceContext,
  audience: 'admin' | 'confirmation',
): Promise<AccessIdentity> {
  const config = adminConfig(context)
  if (audience === 'confirmation' && !config.confirmationEnabled) throw new ApiFailure('FORBIDDEN')
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) throw new ApiFailure('AUTH_REQUIRED')
  if (token.length > adminLimits.jwtCharacters) throw new ApiFailure('AUTH_FAILED')
  let cache = caches.get(config.jwksUrl)
  if (!cache) {
    if (caches.size >= adminLimits.issuers) caches.delete(caches.keys().next().value!)
    cache = { expiresAt: 0, attemptedAt: -Infinity }
    caches.set(config.jwksUrl, cache)
  }
  const expectedAudience = audience === 'admin' ? config.adminAudience : config.confirmationAudience
  try {
    if (!cache.resolver || cache.expiresAt <= context.now()) await refreshKeys(config.jwksUrl, cache, context)
    const options = {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: expectedAudience,
      requiredClaims: ['iss', 'sub', 'email', 'aud', 'exp', 'iat'],
      currentDate: new Date(context.now()),
      clockTolerance: 0,
      maxTokenAge: (audience === 'admin' ? adminLimits.sessionMs : adminLimits.confirmationMs) / 1000,
    }
    const verify = () => jwtVerify(token, cache!.resolver!, options)
    let result
    try {
      result = await verify()
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
      await refreshKeys(config.jwksUrl, cache, context)
      result = await verify()
    }
    const { payload, protectedHeader } = result
    const lifetime = audience === 'admin' ? adminLimits.sessionMs : adminLimits.confirmationMs
    if (
      protectedHeader.jku ||
      protectedHeader.jwk ||
      protectedHeader.x5u ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      payload.exp! <= payload.iat! ||
      (payload.exp! - payload.iat!) * 1000 > lifetime ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      payload.sub.length > 256 ||
      !z.email().max(254).safeParse(payload.email).success ||
      !(typeof payload.aud === 'string'
        ? payload.aud === expectedAudience
        : Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === expectedAudience)
    )
      throw new Error('Invalid identity')
    const identity: AccessIdentity = Object.freeze({
      issuer: config.issuer,
      subject: payload.sub,
      email: payload.email as string,
      tokenExpiresAt: payload.exp! * 1000,
      audience: expectedAudience,
    })
    verifiedIdentities.add(identity)
    return identity
  } catch {
    context.emit({ operation: 'auth', stage: 'admin-access', code: 'AUTH_FAILED' })
    throw new ApiFailure('AUTH_FAILED')
  }
}
