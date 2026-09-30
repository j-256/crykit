import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export function offlinePlugin(): Plugin {
  let publicDirectory = 'public'
  const publicAssets = ['icon.svg', 'manifest.webmanifest', 'pixel-operator-CC0.txt']
  return {
    name: 'crystal-companion-offline',
    apply: 'build',
    configResolved(config) { publicDirectory = config.publicDir },
    generateBundle: { order: 'post', handler(_, bundle) {
      const assets = [...Object.keys(bundle), ...publicAssets].sort()
      const digest = createHash('sha256')
      for (const filename of publicAssets) {
        digest.update(filename)
        digest.update(readFileSync(join(publicDirectory, filename)))
      }
      for (const filename of Object.keys(bundle).sort()) {
        const entry = bundle[filename]
        digest.update(filename)
        digest.update(entry.type === 'chunk' ? entry.code : entry.source)
      }
      const version = digest.digest('hex').slice(0, 16)
      const source = `const CACHE_PREFIX = 'crystal-companion-shell-';
const CACHE_NAME = CACHE_PREFIX + encodeURIComponent(self.registration.scope) + '-' + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(assets)};
const assetUrls = FILES.map(path => new URL(path, self.registration.scope).href);
const indexUrl = new URL('index.html', self.registration.scope).href;
const prepareCache = async () => {
  const cache = await caches.open(CACHE_NAME);
  const matches = await Promise.all(assetUrls.map(url => cache.match(url, { ignoreVary: true })));
  const missing = assetUrls.filter((_, index) => !matches[index]);
  if (missing.length) await cache.addAll(missing.map(url => new Request(url, { cache: 'reload' })));
};
const previousCaches = async () => {
  const names = await caches.keys();
  const currentIndex = names.indexOf(CACHE_NAME);
  if (currentIndex < 0) return [];
  const previous = names.slice(0, currentIndex);
  const owned = [];
  for (const name of previous) {
    if (!name.startsWith(CACHE_PREFIX)) continue;
    const cache = await caches.open(name);
    if (await cache.match(indexUrl, { ignoreVary: true })) owned.push(name);
  }
  return owned;
};
self.addEventListener('install', event => {
  event.waitUntil(prepareCache());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Retain one previous build for open tabs and preserve other installations
    const previous = await previousCaches();
    await Promise.all(previous.slice(0, -1).map(name => caches.delete(name)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'OFFLINE_ACTIVATED' });
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
  if (event.data?.type === 'CHECK_READINESS' || event.data?.type === 'PREPARE_CACHE') {
    event.waitUntil((async () => {
      if (event.data.type === 'PREPARE_CACHE') {
        try { await prepareCache(); } catch { event.ports[0]?.postMessage({ ready: false }); return; }
      }
      const cache = await caches.open(CACHE_NAME);
      const matches = await Promise.all(assetUrls.map(url => cache.match(url, { ignoreVary: true })));
      event.ports[0]?.postMessage({ ready: matches.every(Boolean), version: ${JSON.stringify(version)} });
    })());
  }
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isNavigation = request.mode === 'navigate' && url.href.startsWith(self.registration.scope);
  const isBuildAsset = url.href.startsWith(new URL('assets/', self.registration.scope).href) || url.href.startsWith(new URL('ocr/', self.registration.scope).href);
  if (!isNavigation && !assetUrls.includes(url.href) && !isBuildAsset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Only immutable build assets and the static shell use this URL-only cache
    const cached = await cache.match(isNavigation ? indexUrl : url.href, { ignoreVary: true });
    // Navigation requests reject responses whose fetch followed a redirect
    if (isNavigation && cached?.redirected) return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers });
    if (cached) return cached;
    if (isBuildAsset) {
      for (const name of await previousCaches()) {
        const previous = await (await caches.open(name)).match(url.href, { ignoreVary: true });
        if (previous) return previous;
      }
    }
    return fetch(request);
  })());
});
`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    } },
  }
}
