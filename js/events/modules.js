// Módulos por fenómeno. Interfaz común (la vista detallada solo conoce esto):
//   { type,
//     loadData(evt)            → Promise<data>   (geometría y datos extra; solo se llama al abrir el evento)
//     frame(data, evt)         → { w, e, s, n } | null   (encuadre de la cámara)
//     layers(data, evt)        → [{ id, label, object, decal?, update?(t) }]   (update recibe la hora simulada en ms;
//                                 las capas de área (areaLayer) se pintan sobre el terreno si la zona es pequeña)
//     panel(data, evt)         → { stats: [[valor, etiqueta]], legend: [[color, texto]], rows: [[clave, html]], notes: [texto] }
//     series(data, evt)        → [{ label, unit, color, points: [{ t, v, forecast }] }] }
// Fases siguientes añaden módulos (FIRMS, USGS, GIBS…) con la misma forma.
import * as THREE from 'three';
import { fetchJSON, escapeHtml } from '../net.js';
import { ALERT, utc } from './gdacs.js';
import { polygonsOf, bboxOf, areaLayer } from './draw.js';
import { tubeObject } from './fx.js';
import { latLonToVec3 } from '../geo.js';
import { fireModule } from './fire.js';
import { eonetModule } from './eonet.js';
import { quakeModule } from './quake.js';
import { cycloneExtras, floodExtras, volcanoExtras, fireExtras } from './extras.js';

const DAY = 86400000;
const row = (k, v) => [k, v];

async function fetchBoth(evt) {
  const errors = [];
  const [geo, det] = await Promise.allSettled([
    fetchJSON(evt.geometryUrl, { timeout: 30000 }),
    evt.detailsUrl ? fetchJSON(evt.detailsUrl, { timeout: 15000 }) : Promise.resolve(null),
  ]);
  if (geo.status === 'rejected') errors.push('No se pudo cargar la geometría del evento.');
  if (det.status === 'rejected') errors.push('No se pudieron cargar los datos ampliados.');
  return { geometry: geo.value || null, details: det.value?.properties || null, errors };
}

const featuresOf = (data) => data.geometry?.features || [];
const polys = (data, pred) => featuresOf(data).filter((f) => pred(f.properties?.Class || '', f)).flatMap((f) => polygonsOf(f.geometry).map((p) => ({ ...p, f })));

// ---------------------------------------------------------------------------------
// Genérico: terremoto, inundación, incendio, volcán (polígono(s) + centroide)
// ---------------------------------------------------------------------------------
const GENERIC_NOTES = {
  EQ: ['El círculo es el radio de referencia que usa GDACS para estimar el impacto, no el área realmente sacudida.'],
  FL: ['El polígono es el área afectada según GDACS; no se anima: es la última geometría publicada.'],
  WF: ['El polígono es el área quemada que publica GDACS (GWIS); no se anima: es la última geometría publicada.'],
  VO: ['GDACS publica el centroide del volcán; no hay polígono de afectación.'],
};

const AREA_LABEL = { EQ: 'Radio de referencia', FL: 'Área afectada', WF: 'Área quemada', VO: 'Zona', DR: 'Zona' };

function genericModule(type) {
  return {
    type,
    loadData: fetchBoth,
    frame(data, evt) {
      const rings = polys(data, (c) => c !== 'Poly_Global').map((p) => p.outer);
      return bboxOf(rings) || { w: evt.lon, e: evt.lon, s: evt.lat, n: evt.lat };
    },
    layers(data, evt) {
      const color = ALERT[evt.alert].color;
      const out = [];
      const gate = (t) => type !== "EQ" || t >= evt.from; // el área de incendios e inundaciones es la última publicada: no aparece "en un instante"
      const main = polys(data, (c) => c !== 'Poly_Global');
      const glob = polys(data, (c) => c === 'Poly_Global');
      if (main.length) out.push(areaLayer('area', AREA_LABEL[type], main, { color, fill: 0.28, line: 0.95 }, gate));
      if (glob.length) out.push(areaLayer('global', 'Área global (referencia)', glob, { color, fill: 0, line: 0.35, dashed: true, frame: false }, gate));
      return out;
    },
    panel(data, evt) {
      const rows = [];
      const stats = [];
      const d = data.details;
      const sev = evt.severity;
      const days = Math.max(1, Math.ceil((Math.min(evt.to, Date.now()) - evt.from) / DAY));
      if (type === 'EQ' && d?.earthquakedetails) {
        const q = d.earthquakedetails;
        if (q.magnitude) stats.push([Number(q.magnitude).toLocaleString('es-ES', { minimumFractionDigits: 1 }), 'magnitud']);
        if (q.depth) stats.push([Math.round(Number(q.depth)) + ' km', 'profundidad']);
        stats.push([new Date(evt.from).toISOString().slice(11, 16), 'hora UTC']);
        if (q.rapidpopdescription) rows.push(row('Expuestos', escapeHtml(q.rapidpopdescription) + '<small>estimación de GDACS</small>'));
      } else if (sev?.severitytext && Number(sev.severity) > 0) {
        stats.push([Math.round(Number(sev.severity)).toLocaleString('es-ES'), (sev.severityunit || '') + ' según GDACS']);
        if (days > 1) stats.push([String(days), 'días de evento']);
        rows.push(row('Severidad', escapeHtml(sev.severitytext)));
      } else {
        rows.push(row('Severidad', '<small>GDACS no publica un valor para este evento</small>'));
        if (days > 1) stats.push([String(days), 'días de evento']);
      }
      if (!data.geometry) rows.push(row('Geometría', '<small>No disponible ahora</small>'));
      const legend = [[ALERT[evt.alert].color, AREA_LABEL[type]], ['#ffffff', 'Baliza: centroide (GDACS)']];
      return { stats, legend, rows, notes: GENERIC_NOTES[type] || [] };
    },
    pulse(data, evt, t) { return type !== 'EQ' || t >= evt.from; },
    series() { return []; },
  };
}

// ---------------------------------------------------------------------------------
// Ciclones tropicales: avisos (JTWC/NHC vía GDACS), viento y previsión
// ---------------------------------------------------------------------------------
const WIND_COLORS = { Poly_Green: '#5fd38d', Poly_Orange: '#ffb547', Poly_Red: '#ff5a4d' };

/** "20/11 18:00" o "18/11 06:00 UTC" → ms (el año se deduce del inicio del evento). */
function labelDate(label, evt) {
  const m = /(\d{1,2})\/(\d{1,2}) (\d{2}):(\d{2})/.exec(label || '');
  if (!m) return NaN;
  const y = new Date(evt.from).getUTCFullYear();
  let ts = Date.UTC(y, m[2] - 1, m[1], m[3], m[4]);
  if (ts < evt.from - 40 * DAY) ts = Date.UTC(y + 1, m[2] - 1, m[1], m[3], m[4]);
  return ts;
}

async function loadTrack(details) {
  const url = (details?.impacts || []).map((i) => i.resource?.timeline).find(Boolean);
  if (!url) return null;
  const d = await fetchJSON(url, { timeout: 30000 });
  const byTime = new Map();
  for (const it of d.channel?.item || []) {
    const t = Date.parse(`${it.advisory_datetime} UTC`);
    const lat = Number(it.latitude), lon = Number(it.longitude), ms = Number(it.wind_speed);
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    byTime.set(t, { t, lat, lon, kmh: Number.isFinite(ms) ? ms * 3.6 : null, forecast: it.actual === 'False', status: [].concat(it.storm_status || [])[0] || '' });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

const tcModule = {
  type: 'TC',
  async loadData(evt) {
    const base = await fetchBoth(evt);
    try { base.track = await loadTrack(base.details); } catch { base.track = null; }
    if (!base.track?.length) base.errors.push('No se pudo cargar la serie de avisos (trayectoria y viento).');
    return base;
  },
  frame(data, evt) {
    const rings = polys(data, (c) => c.startsWith('Poly_') && c !== 'Poly_Cones').map((p) => p.outer);
    const obs = (data.track || []).filter((p) => !p.forecast).map((p) => [p.lon, p.lat]);
    const box = bboxOf(obs.length ? [...rings, obs] : rings);
    return box || { w: evt.lon, e: evt.lon, s: evt.lat, n: evt.lat };
  },
  layers(data, evt, { scale = 0.1 } = {}) {
    const out = [];
    const now = Date.now();
    const past = [], current = [];
    for (const p of polys(data, (c) => c.startsWith('Poly_') || c.startsWith('Point_Polygon'))) {
      const cls = p.f.properties.Class;
      if (cls === 'Poly_Cones') {
        out.push(areaLayer('cone', 'Cono de incertidumbre', [p], { color: '#b48cff', fill: 0, line: 0.55, dashed: true, frame: false }));
        continue;
      }
      const label = p.f.properties.polygonlabel;
      const dateFromLabel = labelDate(label, evt);
      const date = Number.isFinite(dateFromLabel) ? dateFromLabel : utc(p.f.properties.polygondate);
      const hasDateLabel = Number.isFinite(dateFromLabel);
      if (cls.startsWith('Point_Polygon')) past.push({ date, p });
      else if (date > now) { // previsión: tenue y siempre visible
        out.push(areaLayer('fc', 'Previsión de viento', [p], { color: WIND_COLORS[cls] || '#ffb547', fill: 0, line: 0.28, dashed: true, frame: false }));
      } else current.push({ cls, date, hasDateLabel, p });
    }
    // Sin duplicados: si hay polígono con etiqueta de fecha, el de umbral ("60 km/h") con la misma fecha sobra
    const seen = new Set();
    current.sort((a, b) => Number(b.hasDateLabel) - Number(a.hasDateLabel));
    for (const c of current) {
      const key = c.cls + '|' + c.date;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(areaLayer('wind', 'Viento ≥ 60 / 90 / 120 km/h', [c.p], { color: WIND_COLORS[c.cls] || '#ffb547', fill: 0.16, line: 0.95 }, (t) => t >= c.date));
    }
    // Radios de viento de los avisos pasados: solo el más reciente respecto al instante simulado
    past.sort((a, b) => a.date - b.date);
    const idxAt = (t) => { let idx = -1; past.forEach((x, i) => { if (x.date <= t) idx = i; }); return idx; };
    past.forEach((x, i) => out.push(areaLayer('past', 'Radios de viento pasados', [x.p], { color: '#9fe8ff', fill: 0.12, line: 0.85 }, (t) => idxAt(t) === i)));

    // Trayectoria por avisos: tubo luminoso observado hasta el instante simulado, previsión tenue
    const track = data.track || [];
    const obs = track.filter((p) => !p.forecast);
    const fc = track.filter((p) => p.forecast);
    const alt = scale * 0.004, radius = scale * 0.0022;
    const tube = tubeObject(obs, { color: '#ffffff', radius, alt, opacity: 0.85 });
    if (tube) {
      out.push({ id: 'track', label: 'Trayectoria', object: tube, update(t) {
        const i = obs.findIndex((p) => p.t > t);
        const n = i < 0 ? obs.length : i === 0 ? 0 : i + (t - obs[i - 1].t) / (obs[i].t - obs[i - 1].t || 1);
        tube.userData.setProgress(n);
      } });
    }
    const fcTube = tubeObject(obs.length ? [obs[obs.length - 1], ...fc] : fc, { color: '#c9b6ff', radius: radius * 0.6, alt, opacity: 0.35 });
    if (fcTube) out.push({ id: 'track-fc', label: 'Trayectoria', object: fcTube, update() {} });
    return out;
  },
  /** Posición del ciclón en el instante simulado (interpolada entre avisos, solo para la baliza). */
  focus(data, evt, t) {
    const obs = (data.track || []).filter((p) => !p.forecast);
    if (!obs.length) return null;
    if (t <= obs[0].t) return obs[0];
    for (let i = 1; i < obs.length; i++) {
      if (obs[i].t >= t) { const a = obs[i - 1], b = obs[i], f = (t - a.t) / (b.t - a.t || 1); return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }; }
    }
    return obs[obs.length - 1];
  },
  pulse(data, evt, t) { const o = (data.track || []).find((p) => !p.forecast); return !o || t >= o.t; },
  panel(data, evt) {
    const rows = [];
    const sev = evt.severity;
    if (sev?.severitytext) rows.push(row('Viento máx.', escapeHtml(sev.severitytext)));
    const obs = (data.track || []).filter((p) => !p.forecast);
    const last = obs[obs.length - 1];
    if (last) rows.push(row('Último aviso', `${escapeHtml(last.status || 'Ciclón')}${last.kmh != null ? ` · ${Math.round(last.kmh)} km/h` : ''}<small>${last.lat.toFixed(1)}°, ${last.lon.toFixed(1)}° · ${escapeHtml(new Date(last.t).toISOString().slice(0, 16).replace('T', ' '))} UTC</small>`));
    const stats = [];
    const maxKmh = Math.max(0, ...obs.map((p) => p.kmh || 0));
    if (maxKmh) stats.push([Math.round(maxKmh).toLocaleString('es-ES'), 'km/h viento máx.']);
    if (last?.kmh != null) stats.push([Math.round(last.kmh).toLocaleString('es-ES'), 'km/h último aviso']);
    stats.push([String(Math.max(1, Math.ceil((Math.min(evt.to, Date.now()) - evt.from) / DAY))), 'días de evento']);
    const legend = [['#ffffff', 'Trayectoria (aviso)'], ['#ff5a4d', 'Posición (baliza)'], ['#5fd38d', 'Viento ≥ 60 km/h'], ['#ffb547', 'Viento ≥ 90 km/h'], ['#ff5a4d', 'Viento ≥ 120 km/h'], ['#9fe8ff', 'Radios pasados'], ['#b48cff', 'Cono de previsión']];
    return { stats, legend, rows, notes: ['Trayectoria y viento: avisos que recoge GDACS. Entre avisos no hay datos: las líneas son solo guías.', 'Los trazos discontinuos son previsión, no observación.'] };
  },
  series(data) {
    const track = data.track || [];
    const pts = track.filter((p) => p.kmh != null).map((p) => ({ t: p.t, v: p.kmh, forecast: p.forecast }));
    return pts.length ? [{ label: 'Viento sostenido', unit: 'km/h', color: '#ffb547', points: pts }] : [];
  },
};

const MODULES = {
  EO: eonetModule,
  TC: cycloneExtras(tcModule),
  EQ: quakeModule(genericModule('EQ')),
  FL: floodExtras(genericModule('FL')),
  WF: fireExtras(fireModule(genericModule('WF'))),
  VO: volcanoExtras(genericModule('VO')),
  DR: genericModule('DR'),
};
export const getModule = (type) => MODULES[type] || genericModule(type);
