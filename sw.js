// Offline cache: app shell + CDN libraries, so saved notes open without internet.
const CACHE = 'lecture-notes-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'pcm-worklet.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (url.origin !== location.origin && !cdn) return; // API calls go straight to the network
  if (cdn) {
    // versioned URLs never change: cache first
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
    })));
    return;
  }
  // own files: network first so updates arrive, cache when offline
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html'))));
});
