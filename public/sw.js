const CACHE_NAME = 'swingiq-v2';

// Only cache static assets — NEVER intercept API or external requests
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install — cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Activate — clear old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — BYPASS semua request kecuali static assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Bypass: API calls, external services, POST requests
  const isApiCall = url.pathname.startsWith('/api/');
  const isExternal = url.origin !== self.location.origin;
  const isPost = e.request.method !== 'GET';
  const isCloudinary = url.hostname.includes('cloudinary');
  const isOpenAI = url.hostname.includes('openai');

  if (isApiCall || isExternal || isPost || isCloudinary || isOpenAI) {
    // Go straight to network, no cache
    return;
  }

  // For static GET requests: cache first, fallback to network
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request))
      .catch(() => fetch(e.request))
  );
});
