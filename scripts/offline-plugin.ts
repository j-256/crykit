import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export function offlinePlugin(): Plugin {
  let publicDirectory = 'public'
  const publicAssets = ['icon.svg', 'manifest.webmanifest', 'pixel-operator-CC0.txt']
  return {
    name: 'crykit-offline',
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
      const source = `const CACHE_PREFIX = 'crykit-shell-';
const CACHE_NAME = CACHE_PREFIX + encodeURIComponent(self.registration.scope) + '-' + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(assets)};
const assetUrls = FILES.map(path => new URL(path, self.registration.scope).href);
const indexUrl = new URL('index.html', self.registration.scope).href;
const refreshPointerUrl = new URL('__crykit_app_cache__', self.registration.scope).href;
const DOWNLOAD_BATCH_SIZE = 8;
const CONCURRENT_DOWNLOAD_BATCHES = 4;
const refreshPrefix = name => name.replace(CACHE_PREFIX, 'crykit-refresh-') + '-';
const applicationCache = async (name = CACHE_NAME) => {
  const cache = await caches.open(name);
  const pointer = await cache.match(refreshPointerUrl);
  const refreshed = pointer && await pointer.text();
  if (refreshed && refreshed.startsWith(refreshPrefix(name)) && await caches.has(refreshed)) return caches.open(refreshed);
  return cache;
};
const downloadFiles = async (cache, urls) => {
  let index = 0;
  let failed = false;
  const download = async () => {
    while (!failed && index < urls.length) {
      const batch = urls.slice(index, index += DOWNLOAD_BATCH_SIZE);
      try { await cache.addAll(batch.map(url => new Request(url, { cache: 'reload' }))); }
      catch (error) { failed = true; throw error; }
    }
  };
  // Drain in-flight writes before a failed refresh removes its staged cache
  const results = await Promise.allSettled(Array.from({ length: CONCURRENT_DOWNLOAD_BATCHES }, download));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
};
const cachedUrls = async cache => new Set((await cache.keys()).filter(request => request.method === 'GET').map(request => request.url));
const prepareCache = async () => {
  const cache = await applicationCache();
  const present = await cachedUrls(cache);
  const missing = assetUrls.filter(url => !present.has(url));
  await downloadFiles(cache, missing);
};
let refreshing;
const refreshCache = async () => {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const name = refreshPrefix(CACHE_NAME) + crypto.randomUUID();
    let committed = false;
    try {
      const staged = await caches.open(name);
      await downloadFiles(staged, assetUrls);
      const cache = await caches.open(CACHE_NAME);
      await cache.put(refreshPointerUrl, new Response(name));
      committed = true;
      const names = await caches.keys();
      await Promise.allSettled(names.filter(previous => previous !== name && previous.startsWith(refreshPrefix(CACHE_NAME))).map(previous => caches.delete(previous)));
    } finally {
      if (!committed) await caches.delete(name);
    }
  })().finally(() => { refreshing = undefined; });
  return refreshing;
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
    const names = await caches.keys();
    const obsolete = previous.slice(0, -1);
    await Promise.all(names.filter(name => obsolete.includes(name) || obsolete.some(previous => name.startsWith(refreshPrefix(previous)))).map(name => caches.delete(name)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'OFFLINE_ACTIVATED' });
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
  if (event.data?.type === 'CHECK_READINESS' || event.data?.type === 'PREPARE_CACHE' || event.data?.type === 'REFRESH_CACHE') {
    event.waitUntil((async () => {
      try {
        if (event.data.type === 'PREPARE_CACHE') await prepareCache();
        if (event.data.type === 'REFRESH_CACHE') await refreshCache();
        const cache = await applicationCache();
        const present = await cachedUrls(cache);
        event.ports[0]?.postMessage({ ready: assetUrls.every(url => present.has(url)), version: ${JSON.stringify(version)} });
      } catch (error) { event.ports[0]?.postMessage({ ready: false, error: error instanceof Error ? error.message : 'Application cache operation failed' }); }
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
    const cache = await applicationCache();
    // Only immutable build assets and the static shell use this URL-only cache
    const cached = await cache.match(isNavigation ? indexUrl : url.href, { ignoreVary: true });
    // Navigation requests reject responses whose fetch followed a redirect
    if (isNavigation && cached?.redirected) return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers });
    if (cached) return cached;
    if (isBuildAsset) {
      for (const name of await previousCaches()) {
        const previous = await (await applicationCache(name)).match(url.href, { ignoreVary: true });
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
