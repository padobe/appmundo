// Terremotos con datos de USGS: intensidad ShakeMap (contornos MMI) pintada sobre el relieve,
// réplicas a su hora y ondas sísmicas ilustrativas.
import { fetchJSON, escapeHtml } from '../net.js';
import { quakePointsObject, wavesObject } from './fx2.js';

const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson';
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 19);
const MMI_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const MMI_TEXT = { 4: 'ligero', 5: 'moderado', 6: 'fuerte', 7: 'muy fuerte', 8: 'severo', 9: 'violento', 10: 'extremo' };

async function loadUsgs(evt) {
  const near = `&latitude=${evt.lat}&longitude=${evt.lon}`;
  const main = await fetchJSON(`${USGS}&starttime=${iso(evt.from - 180000)}&endtime=${iso(evt.from + 180000)}${near}&maxradiuskm=150&orderby=magnitude&limit=1`, { timeout: 15000 });
  const f = main.features?.[0];
  if (!f) return null;
  const mag = f.properties.mag || 5;
  const R = mag >= 7.5 ? 400 : mag >= 6.5 ? 200 : 100;
  const [det, aft] = await Promise.allSettled([
    fetchJSON(f.properties.detail, { timeout: 15000 }),
    fetchJSON(`${USGS}&starttime=${iso(f.properties.time + 1000)}&endtime=${iso(Math.min(Date.now(), f.properties.time + 14 * DAY))}${near}&maxradiuskm=${R}&minmagnitude=2.5&orderby=time-asc&limit=500`, { timeout: 15000 }),
  ]);
  const out = { id: f.id, url: f.properties.url, mag, time: f.properties.time, depth: f.geometry.coordinates[2], lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], contours: null, after: [] };
  const shake = det.value?.properties?.products?.shakemap?.[0];
  const cu = shake?.contents?.['download/cont_mmi.json']?.url;
  if (cu) { try { out.contours = (await fetchJSON(cu, { timeout: 15000 })).features || null; } catch { /* sin ShakeMap */ } }
  out.after = (aft.value?.features || []).map((q) => ({ t: q.properties.time, mag: q.properties.mag || 0, lat: q.geometry.coordinates[1], lon: q.geometry.coordinates[0], depth: Math.max(0, q.geometry.coordinates[2] || 0) }));
  return out;
}

const lines = (g) => (g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []);

export function quakeModule(base) {
  return {
    ...base,
    rings: false, // las ondas sísmicas sustituyen a los anillos de la baliza
    async loadData(evt) {
      const [d, u] = await Promise.allSettled([base.loadData(evt), loadUsgs(evt)]);
      const data = d.value || { errors: ['No se pudieron cargar los datos de GDACS.'] };
      data.usgs = u.value || null;
      if (u.status === 'rejected') data.errors.push('No se pudo consultar USGS (intensidad y réplicas).');
      return data;
    },
    window(data, evt) {
      const a = data.usgs?.after;
      if (!a?.length) return null;
      const start = evt.from - 3 * 3600000;
      return { start, end: Math.min(Date.now(), Math.max(evt.from + 21 * 3600000, a[a.length - 1].t + 3600000)) };
    },
    frame(data, evt) {
      const box = base.frame(data, evt);
      const pts = (data.usgs?.contours || []).flatMap((f) => lines(f.geometry).flat());
      if (!pts.length) return box;
      const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
      return { w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats) };
    },
    layers(data, evt, env = {}) {
      const out = base.layers(data, evt, env);
      const u = data.usgs;
      const lat = u?.lat ?? evt.lat, lon = u?.lon ?? evt.lon;
      const waves = wavesObject({ lat, lon, radius: (env.scale || 0.02) * 0.32, tiles: env.tiles });
      out.push({ id: 'waves', label: 'Ondas sísmicas (ilustrativo)', object: waves, update(t) { waves.visible = this.visible = t >= evt.from; } });
      if (u?.contours?.length) {
        const feats = u.contours.filter((f) => f.properties?.value >= 2);
        const all = feats.flatMap((f) => lines(f.geometry).flat());
        const lons = all.map((p) => p[0]), lats = all.map((p) => p[1]);
        const rect = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)], [Math.min(...lons), Math.max(...lats)]];
        const shakeLayer = {
          id: 'shake', label: 'Intensidad ShakeMap (USGS)', object: null, visible: true,
          decal: {
            polys: [{ outer: rect, holes: [] }], frame: true,
            custom(g, { toX, toY }) {
              const lw = Math.max(3, g.canvas.width / 400);
              g.lineJoin = g.lineCap = 'round';
              for (const f of feats.sort((a, b) => a.properties.value - b.properties.value)) {
                const col = f.properties.color || '#ffb547';
                for (const ln of lines(f.geometry)) {
                  g.beginPath();
                  ln.forEach(([x, y], i) => (i ? g.lineTo(toX(x), toY(y)) : g.moveTo(toX(x), toY(y))));
                  g.save(); g.globalAlpha = 0.45; g.strokeStyle = col; g.lineWidth = lw * 5; g.filter = `blur(${Math.round(lw * 2)}px)`; g.stroke(); g.restore();
                  g.globalAlpha = 0.95; g.strokeStyle = col; g.lineWidth = lw; g.stroke();
                }
              }
              g.globalAlpha = 1;
            },
          },
          update(t) { this.visible = t >= evt.from; },
        };
        out.push(shakeLayer);
      }
      if (u?.after?.length) {
        const pts = quakePointsObject(u.after, { tiles: env.tiles, t0: u.time });
        out.push({ id: 'after', label: 'Réplicas (USGS)', object: pts, update(t) { pts.userData.setTime(t); } });
      }
      return out;
    },
    labels(data, evt) {
      const u = data.usgs;
      const out = [{ lat: u?.lat ?? evt.lat, lon: u?.lon ?? evt.lon, text: `M ${(u?.mag ?? Number(data.details?.earthquakedetails?.magnitude) ?? 0).toLocaleString('es-ES', { maximumFractionDigits: 1 })}`, sub: u ? `epicentro · ${Math.round(u.depth)} km de profundidad` : 'epicentro', kind: 'big', t: evt.from }];
      // Una etiqueta por nivel de intensidad, en el punto más al norte de su contorno
      const seen = new Set();
      for (const f of (u?.contours || []).sort((a, b) => b.properties.value - a.properties.value)) {
        const v = Math.round(f.properties.value);
        if (v < 4 || seen.has(v)) continue;
        const pts = lines(f.geometry).flat();
        if (!pts.length) continue;
        seen.add(v);
        const top = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
        out.push({ lat: top[1], lon: top[0], text: `MMI ${MMI_ROMAN[v] || v}`, sub: MMI_TEXT[v] || '', kind: 'mmi', t: evt.from });
      }
      for (const q of [...(u?.after || [])].sort((a, b) => b.mag - a.mag).slice(0, 3)) {
        if (q.mag >= 4.5) out.push({ lat: q.lat, lon: q.lon, text: `M ${q.mag.toFixed(1)}`, sub: 'réplica', t: q.t });
      }
      return out;
    },
    panel(data, evt) {
      const p = base.panel(data, evt);
      const u = data.usgs;
      const rows = [...p.rows];
      const legend = [...p.legend];
      if (u) {
        rows.push(['USGS', `<a href="${escapeHtml(u.url)}" target="_blank" rel="noopener">${escapeHtml(u.id)}</a><small>M ${u.mag} · ${Math.round(u.depth)} km de profundidad</small>`]);
        rows.push(['Réplicas', u.after.length ? `${u.after.length} de M ≥ 2,5<small>máx. M ${Math.max(...u.after.map((q) => q.mag)).toFixed(1)} · catálogo USGS</small>` : '<small>Ninguna de M ≥ 2,5 en el catálogo USGS</small>']);
        if (!u.contours) rows.push(['ShakeMap', '<small>USGS no ha publicado mapa de intensidad para este sismo</small>']);
        if (u.contours) legend.push(['#ffb547', 'Intensidad MMI (ShakeMap)']);
        if (u.after.length) legend.push(['#ffe873', 'Réplica superficial'], ['#9a66ff', 'Réplica profunda']);
      } else rows.push(['USGS', '<small>No se encontró este sismo en el catálogo de USGS</small>']);
      legend.push(['#73bfff', 'Ondas P/S (ilustrativo)']);
      return { ...p, rows, legend, notes: [...p.notes, 'Contornos de intensidad: ShakeMap de USGS (escala de Mercalli). Las ondas son una ilustración, no una simulación.'] };
    },
    series(data) {
      const a = data.usgs?.after || [];
      return a.length > 1 ? [{ label: 'Réplicas', unit: 'magnitud (USGS)', color: '#ffb547', points: a.map((q) => ({ t: q.t, v: q.mag })), note: 'Cada punto es una réplica. Toca la gráfica para mover la línea de tiempo.' }] : [];
    },
  };
}
