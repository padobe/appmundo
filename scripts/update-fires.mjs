// Recorta los focos de calor de NASA FIRMS (VIIRS NOAA-20 y NOAA-21, últimos 7 días, ficheros
// públicos sin clave) a la zona de cada incendio activo de GDACS y lo guarda en data/fires/<evento>.json
// (un fichero pequeño por evento: la web solo descarga el del incendio que se abre).
// Lo ejecuta la GitHub Action .github/workflows/fires.yml cada 3 h; también a mano:
//   node scripts/update-fires.mjs
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { loadEventList } from '../js/events/gdacs.js';

const BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire';
const SOURCES = [
  { name: 'VIIRS NOAA-20', url: `${BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv` },
  { name: 'VIIRS NOAA-21', url: `${BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_7d.csv` },
];
const MAX_PER_EVENT = 2500;
const MAX_HALF = 1.2; // una zona nunca pasa de ±1,2° (~130 km) alrededor del centroide
const MARGIN = 0.15; // grados (~17 km) alrededor del polígono de GDACS
const MIN_HALF = 0.25; // y como mínimo ±0,25° del centroide

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// 1. Zonas de los incendios activos (polígono de GDACS + margen)
const events = (await loadEventList()).filter((e) => e.type === 'WF');
const zones = [];
for (const e of events) {
  let w = e.lon, ea = e.lon, s = e.lat, n = e.lat;
  try {
    const g = await json(e.geometryUrl);
    for (const f of g.features || []) {
      if (f.properties?.Class === 'Poly_Global') continue;
      const rings = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.map((p) => p[0]) : [];
      for (const r of rings) for (const [lon, lat] of r) { w = Math.min(w, lon); ea = Math.max(ea, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    }
  } catch (err) {
    console.warn(`${e.key}: sin polígono (${err.message}), se usa solo el centroide`);
  }
  const cl = (v, c) => Math.min(c + MAX_HALF, Math.max(c - MAX_HALF, v));
  zones.push({ key: e.key, w: cl(Math.min(w, e.lon - MIN_HALF) - MARGIN, e.lon), e: cl(Math.max(ea, e.lon + MIN_HALF) + MARGIN, e.lon), s: cl(Math.min(s, e.lat - MIN_HALF) - MARGIN, e.lat), n: cl(Math.max(n, e.lat + MIN_HALF) + MARGIN, e.lat) });
}
console.log(`${zones.length} incendios activos en GDACS`);

// 2. Detecciones dentro de cada zona
const out = Object.fromEntries(zones.map((z) => [z.key, []]));
const used = [];
for (const src of SOURCES) {
  let text;
  try {
    const r = await fetch(src.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (err) {
    console.warn(`${src.name}: ${err.message}, se omite`);
    continue;
  }
  used.push(src.name);
  const lines = text.split('\n');
  const head = lines[0].split(',');
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  let kept = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < head.length) continue;
    const lat = +c[ix.latitude], lon = +c[ix.longitude];
    for (const z of zones) {
      if (lat < z.s || lat > z.n || lon < z.w || lon > z.e) continue;
      const hhmm = c[ix.acq_time].padStart(4, '0');
      const t = Date.parse(`${c[ix.acq_date]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) / 1000;
      out[z.key].push([+lat.toFixed(4), +lon.toFixed(4), t, +c[ix.frp], c[ix.confidence], c[ix.satellite]]);
      kept++;
    }
  }
  console.log(`${src.name}: ${lines.length - 1} detecciones en el mundo, ${kept} en zonas de incendio`);
}
if (!used.length) { console.error('Sin datos de FIRMS: se conserva el fichero anterior'); process.exit(1); }

// 3. Guardar (solo eventos con detecciones; si hay demasiadas, las más recientes)
const generated = new Date().toISOString();
await rm('data/fires', { recursive: true, force: true });
await mkdir('data/fires', { recursive: true });
let files = 0;
for (const [key, pts] of Object.entries(out)) {
  if (!pts.length) continue;
  pts.sort((a, b) => b[2] - a[2]);
  const truncated = pts.length > MAX_PER_EVENT;
  await writeFile(`data/fires/${key}.json`, JSON.stringify({ generated, sources: used, window: '7d', n: pts.length, truncated, pts: pts.slice(0, MAX_PER_EVENT) }));
  files++;
}
console.log(`data/fires: ${files} eventos con focos`);
