/* Service worker de la app instalable: guarda una copia de la app y sus librerías
   para que abra sin conexión. Los archivos propios se piden primero a la red (así
   siempre se usa la última versión publicada) y las librerías de CDN, que tienen
   versión fija, se sirven desde la copia guardada. */

const CACHE = 'cuervo-pdf-v1';

const APP_SHELL = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/css/styles.css',
    '/js/icons.js',
    '/js/pdf-ops.js',
    '/js/dialogs.js',
    '/js/grid.js',
    '/js/app.js',
    '/js/toolbar.js',
    '/js/ui-fx.js',
    '/js/pwa.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/favicon-32.png',
    '/icons/icon.svg'
];

const CDN_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
    'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/Draggable.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // De a uno: si algún archivo falla, el resto igual queda guardado
        await Promise.all([...APP_SHELL, ...CDN_LIBS].map(url =>
            cache.add(url).catch(() => { /* se reintenta en el próximo uso */ })));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch (e) {
        const cached = await cache.match(request, { ignoreSearch: true })
            || (request.mode === 'navigate' && await cache.match('/'));
        if (cached) return cached;
        throw e;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.respondWith(url.origin === self.location.origin ? networkFirst(request) : cacheFirst(request));
});
