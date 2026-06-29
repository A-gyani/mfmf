// MF, MF! service worker — cache the shell, and auto-update so new deploys land
// without the manual "clear the app" dance (same pattern as Charaivati).
const CACHE = 'mfmf-v14';
const CORE = ['./', './index.html', './manifest.webmanifest', './speed-rupee-logo.svg', './bg.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
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
