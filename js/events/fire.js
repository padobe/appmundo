// Módulo de incendios (fase 2): focos de calor VIIRS de NASA FIRMS, recortados a los incendios
// activos de GDACS por scripts/update-fires.mjs (data/fires.json), perímetros oficiales (EFFIS en
// Europa, NIFC en EE. UU.) y tiempo de Open-Meteo. Amplía el módulo genérico de GDACS (`base`).
// No se calcula superficie a partir de los focos: la de GDACS/GWIS se muestra como dato de su fuente.
import * as THREE from 'three';
import { fetchJSON, escapeHtml, timeAgo } from '../net.js';
import { polygonsOf, bboxOf, areaLayer } from './draw.js';
import { latLonToVec3 } from '../geo.js';

const DAY = 86400000;
const HOUR = 3600000;
const FIRES_DIR = new URL('../../data/fires/', import.meta.url).href;
const PIXEL_DEG = 0.0034; // un píxel VIIRS ≈ 375 m

const AGE = [
  { max: 1, color: '#ff5a1f', label: 'Últimas 24 h' },
  { max: 2, color: '#ffa35c', label: 'Hace 1 día' },
  { max: 3, color: '#ffd98a', label: 'Hace 2 días' },
  { max: Infinity, color: '#fff0c9', label: 'Hace 3 días o más' },
];
const ageColor = (days) => AGE.find((a) => days < a.max).color;
const CONF = { l: 'baja', n: 'nominal', h: 'alta' };
const fmtHM = (ms) => new Date(ms).toISOString().slice(11, 16);

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

async function loadWeather(evt) {
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

    layers(data, evt) {
      const out = base.layers(data, evt);
      const area = out.find((l) => l.id === 'area');
      if (area) area.label = 'Área quemada (GWIS vía GDACS)';

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
        const b = bboxOf([dets.map((p) => [p.lon, p.lat])]);
        const rect = [[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n]];

        // Alternativa 3D (zonas grandes): puntos con color por antigüedad
        const pos = new Float32Array(dets.length * 3);
        dets.forEach((p, i) => latLonToVec3(p.lat, p.lon, 1.0048).toArray(pos, i * 3));
        const col = new Float32Array(dets.length * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
        pts.renderOrder = 6; pts.frustumCulled = false;
        const c = new THREE.Color();

        const layer = {
          id: 'fires', label: 'Focos de calor por antigüedad', object: pts, visible: true,
          decal: {
            polys: [{ outer: rect, holes: [] }], frame: true,
            stamp: (t) => `${countAt(t)}|${Math.floor(t / HOUR)}`,
            custom(g, { toX, toY, k }, t) {
              const n = countAt(t);
              const s = Math.max(6, PIXEL_DEG * k);
              g.globalAlpha = 1;
              for (let i = 0; i < n; i++) {
                g.fillStyle = ageColor((t - ts[i]) / DAY);
                g.fillRect(toX(dets[i].lon) - s / 2, toY(dets[i].lat) - s / 2, s, s);
              }
            },
          },
          update(t) {
            const n = countAt(t);
            layer.visible = n > 0;
            pts.visible = n > 0;
            geo.setDrawRange(0, n);
            for (let i = 0; i < n; i++) { c.set(ageColor((t - ts[i]) / DAY)); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
            geo.attributes.color.needsUpdate = true;
          },
        };
        out.push(layer);
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
      const legend = [...AGE.map((a) => [a.color, a.label]), ...p.legend];
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
