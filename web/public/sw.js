/* App-shell service worker: cache HTML/JS/CSS only. Never cache /api. */
const CACHE = 'ownkeep-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', '/index.html'])).then(() => {
      return self.skipWaiting()
    }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'CACHE_URLS' || !Array.isArray(data.urls)) return
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const url of data.urls) {
        if (typeof url !== 'string') continue
        try {
          const parsed = new URL(url, self.location.origin)
          if (parsed.origin !== self.location.origin) continue
          if (parsed.pathname.startsWith('/api')) continue
          await cache.add(parsed.href)
        } catch {
          // Ignore individual asset cache failures.
        }
      }
    }),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api')) return

  event.respondWith(
    (async () => {
      try {
        const network = await fetch(request)
        if (
          network.ok &&
          (url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.css') ||
            url.pathname === '/' ||
            url.pathname.endsWith('.html') ||
            url.pathname.endsWith('.svg') ||
            url.pathname.endsWith('.woff2') ||
            url.pathname.endsWith('.ico'))
        ) {
          const cache = await caches.open(CACHE)
          void cache.put(request, network.clone())
        }
        return network
      } catch {
        const cached = await caches.match(request)
        if (cached) return cached
        if (request.mode === 'navigate') {
          const index = await caches.match('/index.html')
          if (index) return index
        }
        throw new Error('Offline and not cached')
      }
    })(),
  )
})
