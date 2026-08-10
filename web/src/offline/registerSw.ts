function collectShellAssetUrls(): string[] {
  const urls = new Set<string>(['/', '/index.html'])
  document.querySelectorAll('script[src]').forEach((node) => {
    const src = (node as HTMLScriptElement).src
    if (src) urls.add(src)
  })
  document.querySelectorAll('link[rel="stylesheet"][href]').forEach((node) => {
    const href = (node as HTMLLinkElement).href
    if (href) urls.add(href)
  })
  for (const entry of performance.getEntriesByType('resource')) {
    const resource = entry as PerformanceResourceTiming
    if (
      resource.initiatorType === 'script' ||
      resource.initiatorType === 'link' ||
      resource.initiatorType === 'css' ||
      resource.name.endsWith('.js') ||
      resource.name.endsWith('.css')
    ) {
      urls.add(resource.name)
    }
  }
  return [...urls]
}

export function registerAppShellServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return
  void navigator.serviceWorker
    .register('/sw.js')
    .then(async (registration) => {
      await navigator.serviceWorker.ready
      const worker = registration.active ?? navigator.serviceWorker.controller
      worker?.postMessage({ type: 'CACHE_URLS', urls: collectShellAssetUrls() })
    })
    .catch(() => {
      // Non-fatal: offline reload may fall back to browser HTTP cache.
    })
}
