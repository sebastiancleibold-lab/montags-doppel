// Service Worker: App offline nutzbar. App-Dateien: erst Netz, dann Cache. Bibliotheken (vendor/): aus dem Cache.
const CACHE = 'scanner-v2';
const FILES = ['./', './index.html', './app.js', './imgproc.js', './ocr.js', './pdf.js', './db.js', './pdfin.js', './drive.js', './cats.js', './config.js', './manifest.webmanifest', './icons/icon-192.png'];
const VENDOR = ['./vendor/tesseract.min.js', './vendor/worker.min.js', './vendor/pdf-lib.min.js', './vendor/lang/deu.traineddata.gz'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => caches.open('scanner-vendor-1')).then(c => c.addAll(VENDOR).catch(() => {}))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'scanner-vendor-1').map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open('scanner-vendor-1').then(c => c.match(e.request).then(r => r || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; }))));
    return;
  }
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
