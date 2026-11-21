// Capas extra por fenómeno (se añaden a los módulos base sin tocarlos):
// ciclón → nubes reales del día + espiral; inundación → antes/después; volcán e incendio → penacho con viento real.
import { escapeHtml } from '../net.js';
import { latestImage, cloudsOnly, TRUE_COLOR, FLOOD_BANDS } from './gibs.js';
import { spiralObject, plumeObject } from './fx2.js';
import { loadWeather } from './fire.js';

const DAY = 86400000;
const D2R = Math.PI / 180;
const fmtDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (iso) => fmtDay.format(Date.parse(iso + 'T12:00:00Z'));
const rectOf = (b) => [[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n]];

/** Caja ampliada y limitada; null si cruza el antimeridiano. */
function grow(b, k, maxSpan) {
  const cx = (b.w + b.e) / 2, cy = (b.s + b.n) / 2;
  const hw = Math.min(maxSpan / 2, Math.max(0.3, ((b.e - b.w) / 2) * k)), hh = Math.min(maxSpan / 2, Math.max(0.3, ((b.n - b.s) / 2) * k));
  const box = { w: cx - hw, e: cx + hw, s: Math.max(-85, cy - hh), n: Math.min(85, cy + hh) };
  return box.w < -180 || box.e > 180 ? null : box;
}

/** Capa que pinta una imagen georreferenciada sobre el terreno. */
function imageLayer(id, label, box, draw, stamp) {
  return {
    id, label, object: null, visible: true,
    decal: {
      always: true, polys: [{ outer: rectOf(box), holes: [] }], frame: true, stamp,
      custom(g, { toX, toY }) { draw(g, toX(box.w), toY(box.n), toX(box.e) - toX(box.w), toY(box.s) - toY(box.n)); },
    },
    update() {},
  };
}

// ---------------------------------------------------------------------------------
export function cycloneExtras(base) {
  return {
    ...base,
    async loadData(evt) {
      const data = await base.loadData(evt);
      try {
        const box = grow(base.frame(data, evt), 1.5, 34);
        const img = box && await latestImage(TRUE_COLOR, box, { from: Math.min(Date.now() - DAY, evt.to) });
        if (img) data.sat = { box, canvas: cloudsOnly(img.canvas), day: img.day };
      } catch { /* sin imagen */ }
      if (!data.sat) data.errors.push('No se pudo cargar la imagen de satélite del día (NASA GIBS).');
      return data;
    },
    layers(data, evt, env = {}) {
      const out = base.layers(data, evt, env);
      if (data.sat) {
        const { box, canvas, day } = data.sat;
        out.unshift(imageLayer('sat', `Nubes reales NASA (${dayLabel(day)})`, box, (g, x, y, w, h) => g.drawImage(canvas, x, y, w, h)));
      }
      // Espiral: radio según el área de vientos ≥ 60 km/h más reciente (o 300 km por defecto)
      const green = (data.geometry?.features || []).filter((f) => f.properties?.Class === 'Poly_Green');
      let rDeg = 2.7;
      for (const f of green) {
        const ring = f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : null;
        if (ring) rDeg = Math.max(rDeg, ...ring.map(([x, y]) => Math.hypot((x - evt.lon) * Math.cos(evt.lat * D2R), y - evt.lat)));
      }
      rDeg = Math.min(rDeg, 8);
      const spiral = spiralObject({ radius: rDeg * D2R * 1.15, south: evt.lat < 0, tiles: env.tiles });
      let last = '';
      out.push({
        id: 'spiral', label: 'Espiral de nubes (ilustrativo)', object: spiral,
        update(t) {
          const p = base.focus?.(data, evt, t) || evt;
          const k = p.lat.toFixed(3) + p.lon.toFixed(3);
          if (k !== last) { last = k; spiral.userData.place(p.lat, p.lon); }
        },
      });
      return out;
    },
    labels(data, evt) {
      const obs = (data.track || []).filter((p) => !p.forecast);
      const out = obs.filter((p) => new Date(p.t).getUTCHours() === 0).slice(-8)
        .map((p) => ({ lat: p.lat, lon: p.lon, text: fmtDay.format(p.t), sub: p.kmh != null ? `${Math.round(p.kmh)} km/h` : '', t: p.t }));
      const max = obs.reduce((a, b) => ((b.kmh || 0) > (a?.kmh || 0) ? b : a), null);
      if (max?.kmh) out.push({ lat: max.lat, lon: max.lon, text: `${Math.round(max.kmh)} km/h`, sub: 'viento máximo', kind: 'big', t: max.t });
      return out;
    },
    panel(data, evt) {
      const p = base.panel(data, evt);
      const notes = [...p.notes, 'La espiral de nubes es una ilustración; las nubes reales son la imagen de satélite NASA (VIIRS) del día indicado.'];
      const rows = [...p.rows];
      if (data.sat) rows.push(['Satélite', `NASA GIBS · VIIRS NOAA-20<small>imagen del ${escapeHtml(dayLabel(data.sat.day))}; solo se muestran las nubes</small>`]);
      return { ...p, rows, notes };
    },
  };
}

// ---------------------------------------------------------------------------------
export function floodExtras(base) {
  const state = { split: 0.5 };
  return {
    ...base,
    orbit: false, // con el deslizador antes/después, girar la vista confunde

    async loadData(evt) {
      const data = await base.loadData(evt);
      try {
        const box = grow(base.frame(data, evt), 1.3, 6);
        if (box) {
          const [before, after] = await Promise.all([
            latestImage(FLOOD_BANDS, box, { from: evt.from - 3 * DAY, tries: 5 }),
            latestImage(FLOOD_BANDS, box, { from: Math.min(Date.now() - DAY, evt.to), tries: 4 }),
          ]);
          if (before && after) data.ba = { box, before, after };
        }
      } catch { /* sin imágenes */ }
      if (!data.ba) data.errors.push('No se pudieron cargar las imágenes antes/después (NASA GIBS).');
      return data;
    },
    layers(data, evt, env = {}) {
      const out = base.layers(data, evt, env);
      if (data.ba) {
        const { box, before, after } = data.ba;
        out.unshift(imageLayer('ba', 'Antes / después (NASA MODIS)', box, (g, x, y, w, h) => {
          g.drawImage(after.canvas, x, y, w, h);
          g.save();
          g.beginPath(); g.rect(x, y, w * state.split, h); g.clip();
          g.drawImage(before.canvas, x, y, w, h);
          g.restore();
          const lw = Math.max(3, g.canvas.width / 600);
          g.fillStyle = '#ffffff'; g.fillRect(x + w * state.split - lw / 2, y, lw, h);
        }, () => String(state.split)));
      }
      return out;
    },
    panel(data, evt) {
      const p = base.panel(data, evt);
      const rows = [...p.rows];
      if (data.ba) {
        rows.push(['Antes / después', `<input id="ev-split" class="ev-split" type="range" min="0" max="100" value="${Math.round(state.split * 100)}" aria-label="Deslizador antes y después"><small>izquierda: ${escapeHtml(dayLabel(data.ba.before.day))} · derecha: ${escapeHtml(dayLabel(data.ba.after.day))} · NASA MODIS Terra, bandas 7-2-1 (el agua se ve azul oscuro)</small>`]);
      }
      return { ...p, rows, legend: [...p.legend, ['#1d3b8f', 'Agua (bandas 7-2-1)']] };
    },
    bind(root, repaint) {
      root.querySelector('#ev-split')?.addEventListener('input', (e) => { state.split = e.target.value / 100; repaint(); });
    },
  };
}

// ---------------------------------------------------------------------------------
export function volcanoExtras(base) {
  return {
    ...base,
    async loadData(evt) {
      const [d, w] = await Promise.allSettled([base.loadData(evt), loadWeather(evt)]);
      const data = d.value || { errors: ['No se pudieron cargar los datos del evento.'] };
      data.weather = w.value || null;
      return data;
    },
    frame(data, evt) { return { w: evt.lon - 0.12, e: evt.lon + 0.12, s: evt.lat - 0.12, n: evt.lat + 0.12 }; },
    layers(data, evt, env = {}) {
      const out = base.layers(data, evt, env);
      const wx = data.weather;
      const plume = plumeObject([{ lat: evt.lat, lon: evt.lon }], {
        tiles: env.tiles, windFrom: wx?.dir ?? 270, windKmh: wx?.wind ?? 15, height: (env.scale || 0.01) * 0.28,
        color: [0.36, 0.34, 0.33], count: 1600, rate: 0.045, size: 1.2,
      });
      out.push({ id: 'plume', label: 'Penacho de ceniza (ilustrativo)', object: plume, update() {} });
      return out;
    },
    labels(data, evt) { return [{ lat: evt.lat, lon: evt.lon, text: evt.name.replace(/^Volcano\s*/i, ''), sub: 'volcán', kind: 'big' }]; },
    panel(data, evt) {
      const p = base.panel(data, evt);
      const w = data.weather;
      const rows = [...p.rows];
      if (w) rows.push(['Viento (modelo)', `${Math.round(w.wind)} km/h desde ${Math.round(w.dir)}°<small>Open-Meteo a 10 m; orienta el penacho ilustrativo</small>`]);
      return { ...p, rows, notes: [...p.notes, 'El penacho es una ilustración orientada con el viento real del modelo; no es una observación de ceniza.'] };
    },
  };
}

// ---------------------------------------------------------------------------------
/** Humo de los incendios activos: sale de los grupos de focos de las últimas 24 h. */
export function smokeFor(dets, wx, env) {
  if (!dets?.length) return null;
  const lastT = dets[dets.length - 1].t;
  const recent = dets.filter((d) => d.t > lastT - DAY);
  const cells = new Map();
  for (const d of recent) {
    const k = Math.round(d.lat / 0.04) + ',' + Math.round(d.lon / 0.04);
    const c = cells.get(k) || { lat: 0, lon: 0, n: 0, w: 0 };
    c.lat += d.lat; c.lon += d.lon; c.n++; c.w += 1 + (d.frp || 0) / 50;
    cells.set(k, c);
  }
  const sources = [...cells.values()].sort((a, b) => b.w - a.w).slice(0, 14).map((c) => ({ lat: c.lat / c.n, lon: c.lon / c.n, w: c.w }));
  return plumeObject(sources, { tiles: env.tiles, windFrom: wx?.dir ?? 270, windKmh: wx?.wind ?? 10, height: (env.scale || 0.01) * 0.12, color: [0.5, 0.47, 0.45], count: 1800, rate: 0.04 });
}

export function fireExtras(base) {
  return {
    ...base,
    layers(data, evt, env = {}) {
      const out = base.layers(data, evt, env);
      const dets = data.fires?.dets;
      const smoke = smokeFor(dets, data.weather, env);
      if (smoke) {
        const first = dets[0].t;
        out.push({ id: 'smoke', label: 'Humo (ilustrativo, viento real)', object: smoke, update(t) { smoke.visible = this.visible = t >= first; } });
      }
      return out;
    },
    labels(data, evt) {
      const dets = data.fires?.dets || [];
      if (!dets.length) return [];
      const top = dets.reduce((a, b) => ((b.frp || 0) > (a.frp || 0) ? b : a));
      const out = [{ lat: top.lat, lon: top.lon, text: `${Math.round(top.frp)} MW`, sub: 'foco más potente (FRP)', kind: 'big', t: top.t }];
      const w = data.weather;
      if (w) out.push({ lat: evt.lat, lon: evt.lon, text: `${Math.round(w.wind)} km/h ${['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(w.dir / 45) % 8]}`, sub: 'viento (modelo)' });
      return out;
    },
    panel(data, evt) {
      const p = base.panel(data, evt);
      return { ...p, notes: [...p.notes, 'El humo es una ilustración: sale de los focos de las últimas 24 h y se inclina con el viento real del modelo.'] };
    },
  };
}
