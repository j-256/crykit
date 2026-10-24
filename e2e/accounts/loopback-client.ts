import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Request paths may come from browsers, but destination and trust come only from the owned fixture
// A literal address also prevents DNS rebinding and keeps redirects from selecting another server
export function ownedLoopbackClient(origin: string, certificate?: string) {
  const upstream = new URL(origin)
  const tls = upstream.protocol === 'https:'
  if ((!tls && upstream.protocol !== 'http:') || upstream.hostname !== '127.0.0.1' || !upstream.port || origin !== upstream.origin) throw new Error('Invalid owned loopback origin')
  if (tls && !certificate) throw new Error('Missing owned loopback certificate')
  const port = Number(upstream.port)
  return (path: string, options: Pick<RequestOptions, 'method' | 'headers'>, callback: (response: IncomingMessage) => void) => {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('Invalid owned listener path')
    const target = new URL(path, upstream)
    if (target.origin !== upstream.origin) throw new Error('Invalid owned listener target')
    const request = { hostname: '127.0.0.1', port, path: target.pathname + target.search, method: options.method, headers: options.headers }
    return tls ? httpsRequest({ ...request, ca: certificate, rejectUnauthorized: true }, callback) : httpRequest(request, callback)
  }
}
