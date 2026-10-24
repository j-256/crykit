import { generateKeyPairSync, sign } from 'node:crypto'

// Node-only signed issuer fixture; the runtime bundle never imports signing keys
export function createAccessIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = crypto.randomUUID()
  const issuer = `https://${crypto.randomUUID()}.cloudflareaccess.com`
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }
  return {
    issuer,
    jwks,
    token(now: number, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
      const parts = [
        Buffer.from(JSON.stringify({ alg: 'RS256', kid, ...header })).toString('base64url'),
        Buffer.from(
          JSON.stringify({
            iss: issuer,
            sub: 'synthetic-owner',
            email: 'owner@example.org',
            aud: ['ordinary-admin'],
            iat: Math.floor(now / 1000),
            exp: Math.floor(now / 1000) + 3600,
            ...claims,
          }),
        ).toString('base64url'),
      ]
      const input = parts.join('.')
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
    },
  }
}
