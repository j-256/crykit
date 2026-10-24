import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { Plugin } from 'vite'
import { OFFLINE_CONTENT_MANIFEST, OFFLINE_CONTENT_VERSION, OFFLINE_EXTRAS, type OfflineContentId } from '../src/offline-content.ts'

const artworkManifest = JSON.parse(readFileSync(new URL('../src/catalog/game-artwork.json', import.meta.url), 'utf8')) as { assets: Record<string, { file: string }>; uiArtwork: Record<string, { asset: string }>; quintarGuide: Record<string, { asset: string }> }
// Keep instructional and currency icons with the core; optional artwork must not make basic controls unreadable
const coreArtworkFiles = new Set([...Object.values(artworkManifest.uiArtwork), ...Object.values(artworkManifest.quintarGuide)].map(binding => artworkManifest.assets[binding.asset].file))
const startupSource = readFileSync(new URL('./browser-startup.ts', import.meta.url), 'utf8')
const startupFile = `assets/startup-recovery-${createHash('sha256').update(startupSource).digest('hex').slice(0, 16)}.js`

function installStartupRecovery(html: string, base: string): string {
  const modules: { startOffset: number; endOffset: number }[] = []
  let bodyEnd: number | undefined
  function visit(node: DefaultTreeAdapterTypes.Node): void {
    if ('tagName' in node) {
      if (node.tagName === 'body') bodyEnd = node.sourceCodeLocation?.endTag?.startOffset
      if (node.tagName === 'script' && node.attrs.some(attribute => attribute.name === 'type' && attribute.value.toLowerCase() === 'module') && node.sourceCodeLocation) modules.push(node.sourceCodeLocation)
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
  }
  // Match actual HTML elements, not script-like text in comments, attributes or raw-text elements
  // Source offsets preserve all other bytes; a comment keeps adjacent text from forming a new token
  visit(parse(html, { sourceCodeLocationInfo: true }))
  if (!modules.length || bodyEnd === undefined) return html
  modules.sort((a, b) => a.startOffset - b.startOffset)
  const scripts = modules.map(location => html.slice(location.startOffset, location.endOffset))
  // The loading screen must be parsed before recovery's download can block parsing
  // Retain entry order after recovery so module errors cannot precede its listener
  const edits = [...modules.map(location => ({ ...location, text: '<!-- Entry module moved after startup recovery -->' })), { startOffset: bodyEnd, endOffset: bodyEnd, text: `<script src="${base}${startupFile}"></script>\n${scripts.join('\n')}\n` }]
  for (const edit of edits.sort((a, b) => b.startOffset - a.startOffset)) html = html.slice(0, edit.startOffset) + edit.text + html.slice(edit.endOffset)
  return html
}

export function offlinePlugin(options: { readonly publicAssets?: readonly string[]; readonly indexSource?: string } = {}): Plugin {
  let publicDirectory = 'public'
  let base = '/'
  const publicAssets = options.publicAssets ?? ['icon.svg', 'manifest.webmanifest', 'pixel-operator-CC0.txt']
  return {
    name: 'crykit-offline',
    apply: 'build',
    configResolved(config) { publicDirectory = config.publicDir; base = config.base ?? '/' },
    generateBundle: { order: 'post', handler(_, bundle) {
      // Recovery must register before entry errors and belong to the same versioned offline core
      // Keep the strict script policy: emit a same-origin classic script rather than inline handlers
      for (const [name, entry] of Object.entries(bundle)) if (entry.type === 'asset' && name.endsWith('.html') && typeof entry.source === 'string') {
        entry.source = installStartupRecovery(entry.source, base)
      }
      const startupAsset = { type: 'asset' as const, fileName: startupFile, source: startupSource, originalFileNames: [] as string[] }
      this.emitFile(startupAsset)
      const bundleNames = [...new Set([...Object.keys(bundle), startupFile])].sort()
      const bundled = (name: string) => name === startupFile ? startupAsset : bundle[name]
      const assets = [...bundleNames.map(name => name === options.indexSource ? 'index.html' : name), ...publicAssets, OFFLINE_CONTENT_MANIFEST].sort()
      const groups: Record<OfflineContentId, number[]> = { core: [], artwork: [], maps: [], screenshots: [] }
      const sizes: number[] = []
      for (const [index, name] of assets.entries()) {
        const entry = bundled(name === 'index.html' && options.indexSource ? options.indexSource : name)
        const originals = entry?.type === 'asset' ? entry.originalFileNames ?? [] : []
        // Unknown assets stay essential; optional membership must come from their source directory
        const essentialArtwork = originals.some(path => coreArtworkFiles.has(path.slice(path.lastIndexOf('/') + 1)))
        let group: OfflineContentId = 'core'
        if (name.startsWith('ocr/')) group = 'screenshots'
        else if (!essentialArtwork && originals.length > 0) {
          if (originals.every(path => /(?:^|\/)src\/assets\/world-map\//.test(path))) group = 'maps'
          else if (originals.every(path => /(?:^|\/)src\/assets\/(?:game-assets|wiki-sprites|mod-artwork)\//.test(path))) group = 'artwork'
        }
        groups[group].push(index)
        sizes.push(name === OFFLINE_CONTENT_MANIFEST ? 0 : entry ? Buffer.byteLength(entry.type === 'chunk' ? entry.code : entry.source) : readFileSync(join(publicDirectory, name)).byteLength)
      }
      const contents = Object.entries(groups).map(([id, indices]) => ({ id, files: indices.length, bytes: indices.reduce((sum, index) => sum + sizes[index], 0) }))
      const manifest = JSON.stringify({ version: OFFLINE_CONTENT_VERSION, contents })
      sizes[assets.indexOf(OFFLINE_CONTENT_MANIFEST)] = Buffer.byteLength(manifest)
      this.emitFile({ type: 'asset', fileName: OFFLINE_CONTENT_MANIFEST, source: manifest })
      const digest = createHash('sha256')
      digest.update(`offline-content-${OFFLINE_CONTENT_VERSION}`)
      digest.update(manifest)
      for (const filename of publicAssets) {
        digest.update(filename)
        digest.update(readFileSync(join(publicDirectory, filename)))
      }
      for (const filename of bundleNames) {
        const entry = bundled(filename)
        digest.update(filename)
        digest.update(entry.type === 'chunk' ? entry.code : entry.source)
      }
      const version = digest.digest('hex').slice(0, 16)
      const source = `const CACHE_PREFIX = 'crykit-shell-';
const CACHE_NAME = CACHE_PREFIX + encodeURIComponent(self.registration.scope) + '-' + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(assets)};
const GROUPS = ${JSON.stringify(groups)};
const SIZES = ${JSON.stringify(sizes)};
const EXTRA_IDS = ${JSON.stringify(Object.keys(OFFLINE_EXTRAS))};
const CONTENT_VERSION = ${OFFLINE_CONTENT_VERSION};
const assetUrls = FILES.map(path => new URL(path, self.registration.scope).href);
const assetUrlSet = new Set(assetUrls);
const indexUrl = new URL('index.html', self.registration.scope).href;
const refreshPointerUrl = new URL('__crykit_app_cache__', self.registration.scope).href;
const selectionUrl = new URL('__crykit_offline_selection__', self.registration.scope).href;
const DOWNLOAD_BATCH_SIZE = 8;
const CONCURRENT_DOWNLOAD_BATCHES = 4;
const PROGRESS_INTERVAL_MS = 100;
const refreshPrefix = name => name.replace(CACHE_PREFIX, 'crykit-refresh-') + '-';
const applicationCache = async (name = CACHE_NAME) => {
  const cache = await caches.open(name);
  const pointer = await cache.match(refreshPointerUrl);
  const refreshed = pointer && await pointer.text();
  if (refreshed && refreshed.startsWith(refreshPrefix(name)) && await caches.has(refreshed)) return caches.open(refreshed);
  return cache;
};
const broadcast = async data => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) if (client.url.startsWith(self.registration.scope)) client.postMessage(data);
};
let mutation = Promise.resolve();
// Installation, optional preparation and refresh share one writer so their selection and cache pointer cannot race
const mutate = action => {
  const result = mutation.then(action);
  mutation = result.catch(() => {});
  return result;
};
const downloadFiles = async (cache, urls, completed = async () => {}) => {
  let index = 0;
  let failed = false;
  const download = async () => {
    while (!failed && index < urls.length) {
      const batch = urls.slice(index, index += DOWNLOAD_BATCH_SIZE);
      try {
        await cache.addAll(batch.map(url => new Request(url, { cache: 'reload' })));
        await completed(batch);
      }
      catch (error) { failed = true; throw error; }
    }
  };
  // Drain in-flight writes before a failed refresh removes its staged cache
  const results = await Promise.allSettled(Array.from({ length: CONCURRENT_DOWNLOAD_BATCHES }, download));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
};
const cachedUrls = async cache => new Set((await cache.keys()).filter(request => request.method === 'GET').map(request => request.url));
const validExtras = extras => {
  if (!Array.isArray(extras) || extras.some(id => !EXTRA_IDS.includes(id))) throw new Error('Unknown offline download');
  return [...new Set(extras)];
};
const selectedExtras = async (cache, inherit = false) => {
  const stored = await cache.match(selectionUrl);
  if (stored) {
    const selection = await stored.json();
    if (selection.version !== CONTENT_VERSION) throw new Error('Offline download choices could not be read. Prepare them again.');
    return validExtras(selection.extras);
  }
  if (inherit) {
    const previous = await previousCaches();
    if (previous.length) {
      // A legacy installation promised every feature; retain that promise when upgrading its app cache
      return selectedExtras(await applicationCache(previous.at(-1))).then(value => value ?? EXTRA_IDS).catch(() => EXTRA_IDS);
    }
  }
  return inherit ? [] : undefined;
};
const storeSelection = (cache, extras) => cache.put(selectionUrl, new Response(JSON.stringify({ version: CONTENT_VERSION, extras }), { headers: { 'Content-Type': 'application/json' } }));
const requiredIndices = extras => [...GROUPS.core, ...extras.flatMap(id => GROUPS[id])];
const populate = async (cache, indices) => {
  const present = await cachedUrls(cache);
  const completed = new Set(indices.filter(index => present.has(assetUrls[index])));
  const totalBytes = indices.reduce((sum, index) => sum + SIZES[index], 0);
  const urlIndices = new Map(indices.map(index => [assetUrls[index], index]));
  let lastProgress = 0;
  const progress = async force => {
    if (!force && Date.now() - lastProgress < PROGRESS_INTERVAL_MS) return;
    lastProgress = Date.now();
    await broadcast({ type: 'OFFLINE_PROGRESS', progress: { completedFiles: completed.size, totalFiles: indices.length, completedBytes: [...completed].reduce((sum, index) => sum + SIZES[index], 0), totalBytes } });
  };
  await progress(true);
  await downloadFiles(cache, indices.filter(index => !completed.has(index)).map(index => assetUrls[index]), async batch => {
    for (const url of batch) completed.add(urlIndices.get(url));
    await progress(false);
  });
  await progress(true);
};
const readiness = async (legacy = false) => {
  const cache = await applicationCache();
  const present = await cachedUrls(cache);
  const extras = await selectedExtras(cache) ?? [];
  const contents = Object.entries(GROUPS).map(([id, indices]) => ({ id, files: indices.length, bytes: indices.reduce((sum, index) => sum + SIZES[index], 0), ready: indices.every(index => present.has(assetUrls[index])), selected: id === 'core' || extras.includes(id) }));
  return { ready: legacy ? assetUrls.every(url => present.has(url)) : contents.every(content => !content.selected || content.ready), contents, version: ${JSON.stringify(version)} };
};
const prepareCache = async requested => {
  const cache = await applicationCache();
  const extras = requested ?? await selectedExtras(cache, true);
  await populate(cache, requiredIndices(extras));
  // Publish choices only after all requested assets succeed; failed extras must leave the usable core intact
  await storeSelection(cache, extras);
};
let refreshing;
const refreshCache = async legacy => {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const name = refreshPrefix(CACHE_NAME) + crypto.randomUUID();
    let committed = false;
    try {
      const staged = await caches.open(name);
      const current = await applicationCache();
      const extras = legacy ? EXTRA_IDS : await selectedExtras(current) ?? [];
      const required = requiredIndices(extras);
      const selected = new Set(required);
      // Unchecking an extra changes future preparation, not the files already available in this build
      const present = await cachedUrls(current);
      for (const [index, url] of assetUrls.entries()) {
        if (selected.has(index) || !present.has(url)) continue;
        const response = await current.match(url);
        if (response) await staged.put(url, response);
      }
      await populate(staged, required);
      await storeSelection(staged, extras);
      // Publish the pointer only after every asset succeeds; a failed refresh must keep the usable installation
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
  event.waitUntil(mutate(() => prepareCache()));
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
      const legacy = event.data.contentVersion !== CONTENT_VERSION;
      try {
        if (event.data.type === 'PREPARE_CACHE') await mutate(() => prepareCache(event.data.extras === undefined ? legacy ? EXTRA_IDS : undefined : validExtras(event.data.extras)));
        if (event.data.type === 'REFRESH_CACHE') await mutate(() => refreshCache(legacy));
        const result = await readiness(legacy);
        event.ports[0]?.postMessage(result);
        if (event.data.type !== 'CHECK_READINESS') await broadcast({ type: 'OFFLINE_STATUS', ...result });
      } catch (error) {
        const result = { ready: false, error: error instanceof Error ? error.message : 'Application cache operation failed' };
        event.ports[0]?.postMessage(result);
        // The requester owns the refresh error; availability still describes the retained installation
        // This broadcast can arrive after its recovery inspection, so never replace a usable cache with the action failure
        const availability = event.data.type === 'REFRESH_CACHE' ? await readiness(legacy).catch(() => result) : result;
        await broadcast({ type: 'OFFLINE_STATUS', ...availability });
      }
    })());
  }
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Fetch Request URLs retain fragments, while the static cache identifies the underlying HTTP asset
  url.hash = '';
  if (url.origin !== self.location.origin) return;
  // Account, admin and hosted publication requests must never resolve through the static shell
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;
  const isNavigation = request.mode === 'navigate' && url.href.startsWith(self.registration.scope);
  const isBuildAsset = url.href.startsWith(new URL('assets/', self.registration.scope).href) || url.href.startsWith(new URL('ocr/', self.registration.scope).href);
  if (!isNavigation && !assetUrlSet.has(url.href) && !isBuildAsset) return;
  event.respondWith((async () => {
    const cache = await applicationCache();
    // Only immutable build assets and the static shell use this URL-only cache
    // Multi-entry installations keep their own HTML pages; only unknown application routes use the shell
    const cached = await cache.match(isNavigation && !assetUrlSet.has(url.href) ? indexUrl : url.href, { ignoreVary: true });
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
