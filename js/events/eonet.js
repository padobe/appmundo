// Módulo de la vista detallada para eventos de NASA EONET: posiciones fechadas
// (sin área afectada ni nivel de alerta, salvo los pocos que traen polígono).
import { escapeHtml } from '../net.js';
import { bboxOf, areaLayer } from './draw.js';
import { tubeObject } from './fx.js';

const DAY = 86400000;
const fmtUTC = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/** Posición en el instante t, interpolada entre dos posiciones (solo para la baliza). */
function positionAt(pts, t) {
  if (!pts.length) return null;
  if (t <= pts[0].t) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1], b = pts[i], f = (t - a.t) / (b.t - a.t || 1);
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
  }
  return pts[pts.length - 1];
}

export const eonetModule = {
  type: 'EO',
  async loadData(evt) { return { points: evt.points || [], polys: evt.polys || [], errors: [] }; },
  frame(data) {
    const b = bboxOf([[...data.points.map((p) => [p.lon, p.lat]), ...data.polys.flatMap((p) => p.outer)]]);
    if (!b) return null;
    const pad = Math.max(0.25, (b.e - b.w) * 0.15, (b.n - b.s) * 0.15);
    return { w: b.w - pad, e: b.e + pad, s: b.s - pad, n: b.n + pad };
  },
  layers(data, evt, { scale = 0.05 } = {}) {
    const out = [];
    if (data.polys.length) out.push(areaLayer('area', 'Zona (EONET)', data.polys, { color: evt.color, fill: 0.2, line: 0.95 }));
    const pts = data.points;
    const tube = pts.length > 1 ? tubeObject(pts, { color: evt.color, radius: scale * 0.002, alt: scale * 0.003, opacity: 0.85 }) : null;
    if (tube) {
      out.push({
        id: 'track', label: 'Recorrido', object: tube,
        update(t) {
          const i = pts.findIndex((p) => p.t > t);
          tube.userData.setProgress(i < 0 ? pts.length : i === 0 ? 0 : i + (t - pts[i - 1].t) / (pts[i].t - pts[i - 1].t || 1));
        },
      });
    }
    return out;
  },
  focus(data, evt, t) { return positionAt(data.points, t) || { lat: evt.lat, lon: evt.lon }; },
  pulse(data, evt, t) { return !data.points.length || t >= data.points[0].t; },
  panel(data, evt) {
    const pts = data.points;
    const last = pts[pts.length - 1];
    const stats = [[String(pts.length || 1), pts.length > 1 ? 'posiciones' : 'posición']];
    if (last?.mag != null) stats.push([Number(last.mag).toLocaleString('es-ES'), last.unit || 'magnitud']);
    stats.push([String(Math.max(1, Math.ceil((Math.min(evt.to, Date.now()) - evt.from) / DAY))), 'días de evento']);
    const rows = [['Categoría', escapeHtml(evt.typeLabel)]];
    if (last) rows.push(['Última posición', `${last.lat.toFixed(2)}°, ${last.lon.toFixed(2)}°<small>${escapeHtml(fmtUTC(last.t))} UTC</small>`]);
    return {
      stats, rows,
      legend: [[evt.color, pts.length > 1 ? 'Recorrido y posición (EONET)' : 'Posición (EONET)']],
      notes: [
        'NASA EONET recopila eventos de otros organismos: publica posiciones fechadas, no el área afectada ni un nivel de alerta.',
        ...(pts.length > 1 ? ['Entre dos posiciones no hay datos: el recorrido es solo una guía.'] : []),
      ],
    };
  },
  series(data) {
    const pts = data.points.filter((p) => p.mag != null);
    return pts.length > 1 ? [{ label: 'Magnitud', unit: pts[0].unit || '', color: '#ffb547', points: pts.map((p) => ({ t: p.t, v: Number(p.mag) })) }] : [];
  },
};
