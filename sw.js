// MF, MF! service worker — cache the shell, and auto-update so new deploys land
// without the manual "clear the app" dance (same pattern as Charaivati).
const CACHE = 'mfmf-v20';
const SHARE_CACHE = 'mfmf-shared';   // transient: files handed in via the Share Target, read once by the page
const CORE = ['./', './index.html', './manifest.webmanifest', './speed-rupee-logo.svg', './bg.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Share Target — a screenshot/PDF was shared into the app from Android's share sheet.
  // There's no server (static Pages host), so the SW catches the POST itself: stash the
  // file(s) in SHARE_CACHE and bounce to ./?shared=1; the page reads them and opens "Add".
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const cache = await caches.open(SHARE_CACHE);
        const now = Date.now();
        // Keep prior shares so screenshots shared one-at-a-time accumulate into ONE order; but
        // prune anything older than 1h (an abandoned share) so two separate orders don't merge.
        for (const k of await cache.keys()) {
          const r = await cache.match(k);
          if (!r || now - (+r.headers.get('X-Shared-At') || 0) > 36e5) await cache.delete(k);
        }
        let i = 0;
        for (const f of form.getAll('files')) {
          if (!f || typeof f === 'string') continue;                 // skip empty/text parts
          await cache.put('shared-' + now + '-' + (i++), new Response(f, {
            headers: { 'Content-Type': f.type || 'application/octet-stream',
                       'X-File-Name': encodeURIComponent(f.name || 'shared'),
                       'X-Shared-At': String(now) }
          }));
        }
      } catch (_) { /* ignore — the page just opens an empty Add screen */ }
      return Response.redirect(self.registration.scope + '?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  // Network-first for page navigations → a fresh shell on the next open, cache as offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Cache-first for everything else (fonts, icon, etc.).
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
