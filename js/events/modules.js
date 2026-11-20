// Módulos por fenómeno. Interfaz común (la vista detallada solo conoce esto):
//   { type,
//     loadData(evt)            → Promise<data>   (geometría y datos extra; solo se llama al abrir el evento)
//     frame(data, evt)         → { w, e, s, n } | null   (encuadre de la cámara)
//     layers(data, evt)        → [{ id, label, object, update?(t) }]   (objetos three.js; update recibe la hora simulada en ms)
//     panel(data, evt)         → { rows: [[clave, html]], notes: [texto] }
//     series(data, evt)        → [{ label, unit, color, points: [{ t, v, forecast }] }] }
// Fases siguientes añaden módulos (FIRMS, USGS, GIBS…) con la misma forma.
import * as THREE from 'three';
import { fetchJSON, escapeHtml } from '../net.js';
import { ALERT, utc } from './gdacs.js';
import { polygonsOf, bboxOf, lineObject, fillObject, pointObject } from './draw.js';
import { latLonToVec3 } from '../geo.js';

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
      for (const p of polys(data, () => true)) {
        const global = p.f.properties.Class === 'Poly_Global';
        const g = new THREE.Group();
        g.add(lineObject(p.outer, { color, opacity: global ? 0.3 : 0.95, dashed: global }));
        if (!global) { const fill = fillObject(p, { color, opacity: 0.18 }); if (fill) g.add(fill); }
        out.push({ id: p.f.properties.Class, object: g, update(t) { g.visible = t >= evt.from; } });
      }
      const pt = pointObject(evt.lat, evt.lon, { color: '#ffffff', size: 9 });
      out.push({ id: 'centroid', object: pt, update(t) { pt.visible = t >= evt.from; } });
      return out;
    },
    panel(data, evt) {
      const rows = [];
      const d = data.details;
      const sev = evt.severity;
      if (type === 'EQ' && d?.earthquakedetails) {
        const q = d.earthquakedetails;
        if (q.magnitude) rows.push(row('Magnitud', `M ${escapeHtml(q.magnitude)}`));
        if (q.depth) rows.push(row('Profundidad', `${escapeHtml(q.depth)} km`));
        if (q.rapidpopdescription) rows.push(row('Expuestos', `${escapeHtml(q.rapidpopdescription)}<small>estimación de GDACS</small>`));
      } else if (sev?.severitytext && Number(sev.severity) > 0) {
        rows.push(row('Severidad', escapeHtml(sev.severitytext)));
      } else {
        rows.push(row('Severidad', '<small>GDACS no publica un valor para este evento</small>'));
      }
      if (!data.geometry) rows.push(row('Geometría', '<small>No disponible ahora</small>'));
      return { rows, notes: GENERIC_NOTES[type] || [] };
    },
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
  layers(data, evt) {
    const out = [];
    const now = Date.now();
    // Polígonos de viento (radios) y cono de previsión
    const past = [], current = [];
    for (const p of polys(data, (c) => c.startsWith('Poly_') || c.startsWith('Point_Polygon'))) {
      const cls = p.f.properties.Class;
      if (cls === 'Poly_Cones') {
        out.push({ id: 'cone', object: lineObject(p.outer, { color: '#b48cff', opacity: 0.55, dashed: true }), update() {} });
        continue;
      }
      const label = p.f.properties.polygonlabel;
      const dateFromLabel = labelDate(label, evt);
      const date = Number.isFinite(dateFromLabel) ? dateFromLabel : utc(p.f.properties.polygondate);
      const hasDateLabel = Number.isFinite(dateFromLabel);
      if (cls.startsWith('Point_Polygon')) {
        const g = new THREE.Group();
        g.add(lineObject(p.outer, { color: '#9fe8ff', opacity: 0.85 }));
        const fill = fillObject(p, { color: '#9fe8ff', opacity: 0.1 }); if (fill) g.add(fill);
        past.push({ date, g });
      } else if (date > now) { // previsión: tenue y siempre visible
        out.push({ id: 'fc', object: lineObject(p.outer, { color: WIND_COLORS[cls] || '#ffb547', opacity: 0.28, dashed: true }), update() {} });
      } else {
        current.push({ cls, date, hasDateLabel, p });
      }
    }
    // Sin duplicados: si hay polígono con etiqueta de fecha, el de umbral ("60 km/h") con la misma fecha sobra
    const seen = new Set();
    current.sort((a, b) => Number(b.hasDateLabel) - Number(a.hasDateLabel));
    for (const c of current) {
      const key = `${c.cls}|${c.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const color = WIND_COLORS[c.cls] || '#ffb547';
      const g = new THREE.Group();
      g.add(lineObject(c.p.outer, { color, opacity: 0.95 }));
      const fill = fillObject(c.p, { color, opacity: 0.13 }); if (fill) g.add(fill);
      out.push({ id: 'wind', object: g, update(t) { g.visible = t >= c.date; } });
    }
    past.sort((a, b) => a.date - b.date);
    // Radios de viento de los avisos pasados: solo el más reciente respecto al instante simulado
    const pastGroup = new THREE.Group();
    for (const x of past) pastGroup.add(x.g);
    out.push({
      id: 'past', object: pastGroup,
      update(t) {
        let idx = -1;
        past.forEach((x, i) => { if (x.date <= t) idx = i; });
        past.forEach((x, i) => { x.g.visible = i === idx; });
      },
    });

    // Trayectoria por avisos: observada hasta el instante simulado, previsión en discontinuo
    const track = data.track || [];
    if (track.length) {
      const obs = track.filter((p) => !p.forecast);
      const fc = track.filter((p) => p.forecast);
      const v = (p) => latLonToVec3(p.lat, p.lon, 1.0048);
      if (obs.length) {
        const geo = new THREE.BufferGeometry().setFromPoints(obs.map(v));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
        line.renderOrder = 5; line.frustumCulled = false;
        const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(obs.map(v)), new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false, depthWrite: false, transparent: true }));
        dots.renderOrder = 5; dots.frustumCulled = false;
        const cur = pointObject(obs[0].lat, obs[0].lon, { color: '#ff5a4d', size: 12 });
        const g = new THREE.Group(); g.add(line, dots, cur);
        out.push({
          id: 'track', object: g,
          update(t) {
            let n = obs.filter((p) => p.t <= t).length;
            line.geometry.setDrawRange(0, Math.max(n, 0));
            dots.geometry.setDrawRange(0, Math.max(n, 0));
            cur.visible = n > 0;
            if (n > 0) { n -= 1; const p = obs[n]; cur.geometry.attributes.position.setXYZ(0, ...v(p).toArray()); cur.geometry.attributes.position.needsUpdate = true; }
          },
        });
      }
      if (fc.length) {
        const from = obs.length ? [obs[obs.length - 1], ...fc] : fc;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(from.map((p) => latLonToVec3(p.lat, p.lon, 1.0048))),
          new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, dashSize: 0.006, gapSize: 0.005 }));
        line.computeLineDistances(); line.renderOrder = 5; line.frustumCulled = false;
        out.push({ id: 'track-fc', object: line, update() {} });
      }
    }
    return out;
  },
  panel(data, evt) {
    const rows = [];
    const sev = evt.severity;
    if (sev?.severitytext) rows.push(row('Viento máx.', escapeHtml(sev.severitytext)));
    const obs = (data.track || []).filter((p) => !p.forecast);
    const last = obs[obs.length - 1];
    if (last) rows.push(row('Último aviso', `${escapeHtml(last.status || 'Ciclón')}${last.kmh != null ? ` · ${Math.round(last.kmh)} km/h` : ''}<small>${last.lat.toFixed(1)}°, ${last.lon.toFixed(1)}° · ${escapeHtml(new Date(last.t).toISOString().slice(0, 16).replace('T', ' '))} UTC</small>`));
    rows.push(row('Leyenda', '<small>Blanco: trayectoria · rojo: posición en el aviso · verde/naranja/rojo: viento ≥ 60 / 90 / 120 km/h · azul: radios de viento pasados · morado discontinuo: cono de incertidumbre (previsión)</small>'));
    return { rows, notes: ['Trayectoria y viento: avisos que recoge GDACS. Entre avisos no hay datos: las líneas son solo guías.', 'Los trazos discontinuos son previsión, no observación.'] };
  },
  series(data) {
    const track = data.track || [];
    const pts = track.filter((p) => p.kmh != null).map((p) => ({ t: p.t, v: p.kmh, forecast: p.forecast }));
    return pts.length ? [{ label: 'Viento sostenido', unit: 'km/h', color: '#ffb547', points: pts }] : [];
  },
};

const MODULES = { TC: tcModule, EQ: genericModule('EQ'), FL: genericModule('FL'), WF: genericModule('WF'), VO: genericModule('VO'), DR: genericModule('DR') };
export const getModule = (type) => MODULES[type] || genericModule(type);
