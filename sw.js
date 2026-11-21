// Caché en disco de teselas (imágenes de satélite, nombres, relieve y luces nocturnas).
// Primero se mira el disco; si no está, se descarga y se guarda. Solo URLs que no cambian
// con el tiempo (las capas con fecha, como nubes o la foto de ayer, no pasan por aquí).
// Límite aproximado: MAX_ENTRIES teselas (~200-300 MB); se borran las más antiguas.
const CACHE = 'tiles-v1';
const MAX_ENTRIES = 9000;
const TRIM_EVERY = 300;
const CACHEABLE = [
  /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\//,
  /^https:\/\/services\.arcgisonline\.com\/ArcGIS\/rest\/services\/Reference\/World_Boundaries_and_Places\/MapServer\/tile\//,
  /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\//,
  /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/VIIRS_Black_Marble\//,
];

let puts = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tiles-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim() {
  const c = await caches.open(CACHE);
  const keys = await c.keys(); // en orden de inserción: las primeras son las más antiguas
  const extra = keys.length - MAX_ENTRIES;
  for (let i = 0; i < extra; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (e.request.method !== 'GET' || !CACHEABLE.some((r) => r.test(url))) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(url);
    if (hit) return hit;
    // Sin la señal de cancelación: si la vista cambia, la tesela se termina de bajar y queda guardada
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil((async () => {
        await c.put(url, copy);
        if (++puts % TRIM_EVERY === 0) await trim();
      })());
    }
    return res;
  })());
});
