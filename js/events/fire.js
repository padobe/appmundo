// Módulo de incendios (fase 2): focos de calor VIIRS de NASA FIRMS, recortados a los incendios
// activos de GDACS por scripts/update-fires.mjs (data/fires.json), perímetros oficiales (EFFIS en
// Europa, NIFC en EE. UU.) y tiempo de Open-Meteo. Amplía el módulo genérico de GDACS (`base`).
// No se calcula superficie a partir de los focos: la de GDACS/GWIS se muestra como dato de su fuente.
import * as THREE from 'three';
import { fetchJSON, escapeHtml, timeAgo } from '../net.js';
import { polygonsOf, bboxOf, areaLayer } from './draw.js';
import { hotspotsObject } from './fx.js';

const DAY = 86400000;
const HOUR = 3600000;
const FIRES_DIR = new URL('../../data/fires/', import.meta.url).href;
const PIXEL_DEG = 0.0034; // un píxel VIIRS ≈ 375 m

const AGE = [
  { max: 1, color: '#ffc04d', label: 'Fuego activo (últimas 24 h)' },
  { max: 2, color: '#ff6a2a', label: 'Brasas (hace 1 día)' },
  { max: 3, color: '#b8361f', label: 'Hace 2 días' },
  { max: Infinity, color: '#4a1f16', label: 'Suelo quemado (3 días o más)' },
];
const ageColor = (days) => AGE.find((a) => days < a.max).color;
const CONF = { l: 'baja', n: 'nominal', h: 'alta' };
const fmtHM = (ms) => new Date(ms).toISOString().slice(11, 16);
const fmtDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtFull = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

/** Ficha de un foco de calor (al pasar el ratón). */
function hotspotHtml(d, now) {
  const age = (now - d.t) / DAY;
  const a = AGE.find((x) => age < x.max);
  const ago = age < 1 ? `hace ${Math.max(1, Math.round(age * 24))} h` : `hace ${Math.floor(age)} d`;
  const sat = d.sat ? `NOAA-${String(d.sat).replace('N', '')}` : 'VIIRS';
  return `
    <div class="tt-kicker" style="--c:${a.color}"><span class="tt-dot"></span>Foco de calor · ${escapeHtml(a.label)}</div>
    <div class="tt-title">${escapeHtml(fmtFull.format(d.t))} UTC</div>
    <div class="tt-meta">${escapeHtml(sat)} · confianza ${escapeHtml(CONF[d.conf] || String(d.conf || '—'))}${d.frp ? ` · ${Math.round(d.frp)} MW` : ''} · ${ago}</div>
    <div class="tt-meta">${d.lat.toFixed(4)}°, ${d.lon.toFixed(4)}° · píxel de ~375 m · NASA FIRMS</div>`;
}

/** Manchas suaves pre-dibujadas para el mapa de calor (mucho más rápido que un gradiente por foco). */
let SPRITES = null;
function heatSprites() {
  if (SPRITES) return SPRITES;
  const make = (stops) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return c;
  };
  SPRITES = {
    scar: make([[0, 'rgba(48,18,12,0.62)'], [0.55, 'rgba(48,18,12,0.45)'], [1, 'rgba(48,18,12,0)']]),
    coal: make([[0, 'rgba(184,54,31,0.55)'], [1, 'rgba(184,54,31,0)']]),
    ember: make([[0, 'rgba(255,106,42,0.75)'], [0.5, 'rgba(220,60,20,0.35)'], [1, 'rgba(200,40,10,0)']]),
    fresh: make([[0, 'rgba(255,240,190,1)'], [0.25, 'rgba(255,170,60,0.85)'], [0.6, 'rgba(255,80,20,0.35)'], [1, 'rgba(255,60,10,0)']]),
  };
  return SPRITES;
}

/** Centro de los focos de cada día UTC, solo del incendio principal (el grupo conectado con más
 *  focos): mezclar fuegos separados daría flechas sin sentido. Días con al menos 3 focos. */
function dailyCentroids(dets) {
  const CELL = 0.03; // ~3 km
  const key = (i, j) => i + "," + j;
  const cells = new Map();
  for (const d of dets) {
    const k = key(Math.floor(d.lon / CELL), Math.floor(d.lat / CELL));
    (cells.get(k) || cells.set(k, []).get(k)).push(d);
  }
  const seen = new Set();
  let best = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    const group = [], stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      group.push(...cells.get(k));
      const [i, j] = k.split(",").map(Number);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const n = key(i + di, j + dj);
        if (cells.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    if (group.length > best.length) best = group;
  }
  const by = new Map();
  for (const d of best) {
    const day = Math.floor(d.t / DAY) * DAY;
    const g = by.get(day) || { day, lat: 0, lon: 0, n: 0 };
    g.lat += d.lat; g.lon += d.lon; g.n++;
    by.set(day, g);
  }
  return [...by.values()].filter((g) => g.n >= 3).sort((x, y) => x.day - y.day).map((g) => ({ day: g.day, lat: g.lat / g.n, lon: g.lon / g.n }));
}

async function loadFires(evt) {
  const res = await fetch(`${FIRES_DIR}${evt.key}.json`, { cache: 'no-store' });
  if (res.status === 404) return { generated: NaN, dets: [], known: false }; // sin focos o aún sin recortar
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const file = await res.json();
  const dets = (file.pts || []).map(([lat, lon, t, frp, conf, sat]) => ({ lat, lon, t: t * 1000, frp, conf, sat }));
  dets.sort((a, b) => a.t - b.t);
  return { generated: Date.parse(file.generated), sources: file.sources || [], truncated: !!file.truncated, total: file.n || dets.length, dets, known: true };
}

const inBox = (lat, lon, [s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e;

async function loadPerimeters(box) {
  const [w, s, e, n] = [box.w - 0.1, box.s - 0.1, box.e + 0.1, box.n + 0.1];
  const cLat = (s + n) / 2, cLon = (w + e) / 2;
  if (inBox(cLat, cLon, [17, -170, 72, -60])) {
    const q = `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=poly_IncidentName,poly_GISAcres&f=geojson&inSR=4326&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&resultRecordCount=30&geometry=${w},${s},${e},${n}`;
    const d = await fetchJSON(q, { timeout: 20000 });
    return { provider: 'NIFC', features: d.features || [] };
  }
  if (inBox(cLat, cLon, [30, -25, 72, 45])) {
    const q = `https://maps.effis.emergency.copernicus.eu/effis?service=WFS&version=1.1.0&request=GetFeature&typename=ms:effis.nrt.ba.poly&outputFormat=GeoJSON&srsName=EPSG:4326&maxFeatures=40&bbox=${s},${w},${n},${e},EPSG:4326`;
    const d = await fetchJSON(q, { timeout: 25000 });
    return { provider: 'EFFIS', features: d.features || [] };
  }
  return { provider: null, features: [] };
}

export async function loadWeather(evt) {
  const q = `https://api.open-meteo.com/v1/forecast?latitude=${evt.lat.toFixed(3)}&longitude=${evt.lon.toFixed(3)}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&past_days=2&forecast_days=1&timezone=GMT`;
  const d = await fetchJSON(q, { timeout: 12000 });
  const h = d.hourly;
  const now = Date.now();
  let i = -1;
  h.time.forEach((s, k) => { if (Date.parse(`${s}:00Z`) <= now) i = k; });
  if (i < 0) return null;
  return { t: Date.parse(`${h.time[i]}:00Z`), temp: h.temperature_2m[i], rh: h.relative_humidity_2m[i], wind: h.wind_speed_10m[i], dir: h.wind_direction_10m[i] };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

export function fireModule(base) {
  return {
    type: 'WF',
    beacon: false, // el propio fuego marca el sitio: la baliza lo tapaba
    async loadData(evt) {
      const data = await base.loadData(evt);
      const box = base.frame(data, evt);
      const [fires, perim, wx] = await Promise.allSettled([loadFires(evt), loadPerimeters(box), loadWeather(evt)]);
      data.fires = fires.value || null;
      if (fires.status === 'rejected') data.errors.push('No se pudieron cargar los focos de calor (FIRMS).');
      data.perim = perim.value || null;
      if (perim.status === 'rejected') data.errors.push('No se pudieron consultar los perímetros oficiales.');
      data.weather = wx.value || null;
      return data;
    },

    window(data) {
      const d = data.fires?.dets;
      if (!d?.length) return null;
      const now = Date.now();
      const start = Math.max(Math.floor(d[0].t / HOUR) * HOUR, now - 7 * DAY);
      const end = Math.min(now, Math.max(d[d.length - 1].t + HOUR, start + 6 * HOUR));
      return { start, end };
    },

    frame(data, evt) {
      const box = base.frame(data, evt);
      const d = data.fires?.dets;
      if (!d?.length) return box;
      // Encuadre sobre el grueso de los focos (percentiles 5–95), no sobre los aislados
      const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
      const lats = d.map((p) => p.lat).sort((a, b) => a - b), lons = d.map((p) => p.lon).sort((a, b) => a - b);
      const pad = 0.03;
      return { w: q(lons, 0.05) - pad, e: q(lons, 0.95) + pad, s: q(lats, 0.05) - pad, n: q(lats, 0.95) + pad };
    },

    layers(data, evt, env = {}) {
      const out = base.layers(data, evt, env);
      const area = out.find((l) => l.id === 'area');
      if (area) {
        area.label = 'Área quemada (GWIS vía GDACS)'; area.wall = false; area.decal.color = '#ff7a45'; area.decal.fill = 0.1;
        area.object.traverse((o) => { if (o.material?.color) o.material.color.set('#ff7a45'); if (o.isMesh) o.material.opacity = 0.08; }); // también en 3D
      }

      const glob = out.find((l) => l.id === 'global');
      if (glob) { glob.decal.color = '#ffb08a'; glob.object.traverse((o) => { if (o.material?.color) o.material.color.set('#ffb08a'); }); }

      // Perímetros oficiales
      const per = data.perim;
      if (per?.features.length) {
        const ps = per.features.flatMap((f) => polygonsOf(f.geometry));
        if (ps.length) out.push(areaLayer('perim', `Perímetro oficial (${per.provider})`, ps, { color: '#ffd24d', fill: 0.06, line: 0.95 }));
      }

      // Focos de calor por antigüedad
      const dets = data.fires?.dets || [];
      if (dets.length) {
        const ts = dets.map((p) => p.t);
        const countAt = (t) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m + 1; else hi = m; } return lo; };
        // 3D: solo el fuego activo (últimas 24 h) brilla y parpadea; el historial va pintado en el suelo
        const pts = hotspotsObject(dets, { tiles: env.tiles, t0: dets[0].t });
        const b = bboxOf([dets.map((p) => [p.lon, p.lat])]);
        const rect = [[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n]];
        const sprites = heatSprites();
        const layer = {
          id: 'fires', label: 'Focos de calor por antigüedad', object: pts, keep3d: true, visible: true, hotspots: pts,
          pick: { items: dets, html: hotspotHtml },
          // Mapa de calor pintado sobre el relieve: suelo quemado (antiguo) → brasas → fuego reciente
          decal: {
            polys: [{ outer: rect, holes: [] }], frame: true,
            stamp: (t) => `${countAt(t)}|${Math.floor(t / HOUR)}`,
            custom(g, { toX, toY, k }, t) {
              const n = countAt(t);
              const r = Math.max(5, PIXEL_DEG * k * 0.95);
              g.globalAlpha = 1;
              g.globalCompositeOperation = 'source-over';
              for (let i = 0; i < n; i++) g.drawImage(sprites.scar, toX(dets[i].lon) - r * 1.4, toY(dets[i].lat) - r * 1.4, r * 2.8, r * 2.8);
              g.globalCompositeOperation = 'lighter';
              for (let i = 0; i < n; i++) {
                const age = (t - ts[i]) / DAY;
                if (age > 3) continue;
                const s = age < 1 ? sprites.fresh : age < 2 ? sprites.ember : sprites.coal;
                const rr = r * (age < 1 ? 1.5 : 1.2);
                g.drawImage(s, toX(dets[i].lon) - rr, toY(dets[i].lat) - rr, rr * 2, rr * 2);
              }
              g.globalCompositeOperation = 'source-over';
            },
          },
          update(t) {
            const n = countAt(t);
            layer.visible = n > 0;
            pts.visible = n > 0;
            pts.userData.setTime(t);
          },
        };
        out.push(layer);

        // Avance diario: centro de los focos de cada día UTC (derivado de FIRMS, solo orientativo)
        const days = dailyCentroids(dets);
        if (days.length >= 2) {
          out.push({
            id: 'spread', label: 'Avance diario', object: new THREE.Group(), visible: true,
            decal: {
              polys: [{ outer: rect, holes: [] }], frame: false,
              stamp: (t) => String(days.filter((d) => d.day <= t).length),
              custom(g, { toX, toY, k }, t) {
                const ds = days.filter((d) => d.day <= t);
                if (ds.length < 2) return;
                const lw = Math.max(3, g.canvas.width / 520);
                const P = ds.map((d) => [toX(d.lon), toY(d.lat)]);
                g.lineCap = g.lineJoin = 'round';
                g.setLineDash([lw * 2.5, lw * 2]);
                g.strokeStyle = 'rgba(20,10,5,0.55)'; g.lineWidth = lw * 2.2;
                g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
                g.strokeStyle = '#ffd27a'; g.lineWidth = lw;
                g.stroke();
                g.setLineDash([]);
                for (let i = 1; i < P.length; i++) {
                  const [x0, y0] = P[i - 1], [x1, y1] = P[i];
                  const len = Math.hypot(x1 - x0, y1 - y0);
                  if (len < lw * 6) continue;
                  const a = Math.atan2(y1 - y0, x1 - x0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2, s = lw * 4.5;
                  g.fillStyle = '#ff8a3d'; g.strokeStyle = 'rgba(20,10,5,0.7)'; g.lineWidth = lw * 0.6;
                  g.beginPath();
                  g.moveTo(mx + Math.cos(a) * s, my + Math.sin(a) * s);
                  g.lineTo(mx + Math.cos(a + 2.5) * s, my + Math.sin(a + 2.5) * s);
                  g.lineTo(mx + Math.cos(a - 2.5) * s, my + Math.sin(a - 2.5) * s);
                  g.closePath(); g.fill(); g.stroke();
                }
                const fs = Math.max(14, g.canvas.width / 70);
                g.font = `600 ${fs}px system-ui, sans-serif`;
                g.textBaseline = 'middle';
                let lx = -1e9, ly = -1e9;
                [...ds.keys()].reverse().forEach((i) => { // del más reciente al más antiguo
                  const d = ds[i];
                  const [x, y] = P[i];
                  g.fillStyle = '#fff3df'; g.beginPath(); g.arc(x, y, lw * 1.6, 0, Math.PI * 2); g.fill();
                  if (Math.hypot(x - lx, y - ly) < fs * 2.4 && i < ds.length - 1) return; // etiquetas sin solaparse
                  lx = x; ly = y;
                  const label = fmtDay.format(d.day);
                  const w = g.measureText(label).width + fs * 0.8;
                  g.fillStyle = 'rgba(14,10,8,0.78)';
                  g.beginPath(); g.roundRect(x + lw * 3, y - fs * 0.75, w, fs * 1.5, fs * 0.4); g.fill();
                  g.fillStyle = '#fff3df'; g.fillText(label, x + lw * 3 + fs * 0.4, y);
                });
              },
            },
            update(t) { this.visible = days[1].day <= t; },
          });
        }
      }
      return out;
    },

    panel(data, evt) {
      const p = base.panel(data, evt);
      const rows = [...p.rows];
      const notes = [];
      const f = data.fires;
      const dets = f?.dets || [];
      let stats = p.stats;

      if (dets.length) {
        const last = dets[dets.length - 1];
        stats = [[f.total.toLocaleString('es-ES'), 'detecciones térmicas · 7 d'], [fmtHM(last.t), 'última detección UTC'], ...p.stats.slice(0, 1)];
        const sats = [...new Set(dets.map((d) => d.sat))].map((s) => `NOAA-${s.replace('N', '')}`).join(' y ');
        rows.push(['Focos', `VIIRS · ${escapeHtml(sats)}<small>NASA FIRMS · datos de ${escapeHtml(timeAgo(f.generated))}</small>`]);
        const conf = {};
        for (const d of dets) conf[d.conf] = (conf[d.conf] || 0) + 1;
        rows.push(['Confianza', Object.entries(conf).map(([k, v]) => `${v} ${CONF[k] || escapeHtml(k)}`).join(' · ')]);
        const frp = Math.max(...dets.map((d) => d.frp || 0));
        if (frp > 0) rows.push(['FRP máx.', `${Math.round(frp)} MW<small>potencia radiativa de un foco, según FIRMS</small>`]);
        if (f.truncated) notes.push(`Se dibujan los ${dets.length.toLocaleString('es-ES')} focos más recientes de ${f.total.toLocaleString('es-ES')}.`);
        if (Date.now() - f.generated > 12 * HOUR) data.errors.push('Los focos de calor tienen más de 12 h: la actualización automática no se ha ejecutado.');
      } else if (f && !f.known) {
        rows.push(['Focos', '<small>Sin focos VIIRS en los últimos 7 días dentro de la zona, o evento nuevo aún sin recortar (se actualiza cada ~6 h)</small>']);
      } else if (f) {
        rows.push(['Focos', '<small>FIRMS no detectó focos en los últimos 7 días dentro de la zona</small>']);
      } else {
        rows.push(['Focos', '<small>No disponibles ahora</small>']);
      }

      // Perímetro oficial
      const per = data.perim;
      if (per?.provider && per.features.length) rows.push(['Perímetro', `${escapeHtml(per.provider)}: ${per.features.length} polígono(s) en la zona<small>${per.provider === 'EFFIS' ? 'áreas quemadas cartografiadas por EFFIS; el servicio no publica fecha ni nombre, pueden no ser este incendio' : 'perímetros oficiales de NIFC que cortan la zona'}</small>`]);
      else if (per?.provider) rows.push(['Perímetro', `<small>Sin perímetro oficial en ${escapeHtml(per.provider)} para esta zona</small>`]);
      else if (per) rows.push(['Perímetro', '<small>Sin perímetro oficial: fuera de la cobertura de EFFIS (Europa) y NIFC (EE. UU.)</small>']);

      // Tiempo
      const w = data.weather;
      if (w) rows.push(['Tiempo (modelo)', `${Math.round(w.temp)} °C · HR ${Math.round(w.rh)} % · viento ${Math.round(w.wind)} km/h ${compass(w.dir)}<small>Open-Meteo, mezcla de modelos a las ${fmtHM(w.t)} UTC en el centroide; no es una estación</small>`]);

      notes.push('Un foco es un píxel de ~375 m con anomalía térmica (VIIRS), no una superficie quemada.');
      notes.push('Las hectáreas son las que publica GDACS (GWIS); no se calculan a partir de los focos.');
      const legend = [...AGE.map((a) => [a.color, a.label]), ['#ff7a45', 'Área quemada (GDACS)']];
      if (dailyCentroids(dets).length >= 2) { legend.push(['#ffd27a', 'Avance diario']); notes.push('El avance diario une el centro de los focos de cada día (UTC) del foco principal: orientativo, no es el frente del fuego.'); }
      if (per?.features.length) legend.push(['#ffd24d', `Perímetro ${per.provider}`]);
      return { stats, legend, rows, notes: [...notes, ...p.notes] };
    },

    series(data) {
      const dets = data.fires?.dets || [];
      if (!dets.length) return [];
      const byDay = new Map();
      for (const d of dets) { const day = Math.floor(d.t / DAY) * DAY; byDay.set(day, (byDay.get(day) || 0) + 1); }
      return [{
        label: 'Detecciones por día', unit: 'focos VIIRS (UTC)', color: '#ffb547', bars: true,
        note: 'Número de focos de calor por día UTC. Toca la gráfica para mover la línea de tiempo.',
        points: [...byDay].map(([t, v]) => ({ t: t + DAY / 2, v })),
      }];
    },
  };
}
