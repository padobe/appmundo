// Capa: fenómenos naturales activos (NASA EONET v3, sin clave).
// Incendios, tormentas (con su trayectoria), volcanes, hielo, inundaciones…
import * as THREE from 'three';
import { latLonToVec3, toScreen, isOccluded } from '../geo.js';
import { fetchJSON, escapeHtml, timeAgo } from '../net.js';

const URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=45';
const REFRESH_MS = 30 * 60 * 1000;

export const EONET_CATS = {
  wildfires: { label: 'Incendio', color: '#ff6a3d', glyph: 'fire' },
  severeStorms: { label: 'Tormenta', color: '#b48cff', glyph: 'storm' },
  volcanoes: { label: 'Volcán', color: '#ff3d6e', glyph: 'volcano' },
  seaLakeIce: { label: 'Hielo', color: '#9fe8ff', glyph: 'ice' },
  floods: { label: 'Inundación', color: '#4da3ff', glyph: 'drop' },
  earthquakes: { label: 'Terremoto', color: '#f6d860', glyph: 'dot' },
  landslides: { label: 'Deslizamiento', color: '#d4a373', glyph: 'dot' },
  drought: { label: 'Sequía', color: '#e0b25a', glyph: 'dot' },
  dustHaze: { label: 'Polvo y bruma', color: '#d9c49a', glyph: 'dot' },
  snow: { label: 'Nieve', color: '#e8f3ff', glyph: 'dot' },
  tempExtremes: { label: 'Temperatura extrema', color: '#ff9f43', glyph: 'dot' },
  waterColor: { label: 'Color del agua', color: '#3ddbb8', glyph: 'dot' },
  manmade: { label: 'Origen humano', color: '#c0c6d4', glyph: 'dot' },
};

function icon(cat) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const col = cat.color;
  g.fillStyle = 'rgba(6,10,18,0.78)';
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.lineWidth = 4; g.strokeStyle = col;
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke();
  g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 4; g.lineCap = 'round';
  switch (cat.glyph) {
    case 'fire':
      g.beginPath(); g.moveTo(32, 14); g.bezierCurveTo(46, 28, 44, 46, 32, 48); g.bezierCurveTo(20, 46, 18, 32, 27, 24);
      g.bezierCurveTo(27, 32, 31, 33, 32, 14); g.fill(); break;
    case 'storm':
      g.beginPath(); g.arc(32, 32, 7, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(32, 32, 15, Math.PI * 0.1, Math.PI * 0.9); g.stroke();
      g.beginPath(); g.arc(32, 32, 15, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); break;
    case 'volcano':
      g.beginPath(); g.moveTo(14, 46); g.lineTo(27, 24); g.lineTo(37, 24); g.lineTo(50, 46); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(32, 20); g.lineTo(32, 12); g.stroke(); break;
    case 'ice':
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3;
        g.beginPath(); g.moveTo(32 - Math.cos(a) * 15, 32 - Math.sin(a) * 15); g.lineTo(32 + Math.cos(a) * 15, 32 + Math.sin(a) * 15); g.stroke();
      }
      break;
    case 'drop':
      g.beginPath(); g.moveTo(32, 14); g.bezierCurveTo(44, 30, 44, 46, 32, 47); g.bezierCurveTo(20, 46, 20, 30, 32, 14); g.fill(); break;
    default:
      g.beginPath(); g.arc(32, 32, 9, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Último punto de un evento (los polígonos se reducen a su centro). */
function pointOf(geom) {
  if (geom.type === 'Point') return geom.coordinates;
  const ring = geom.coordinates?.[0];
  if (!ring?.length) return null;
  const s = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / ring.length, s[1] / ring.length];
}

export class EonetLayer {
  id = 'eonet';
  name = 'NASA EONET';

  constructor(ctx) {
    this.ctx = ctx;
    this.visible = true;
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
    this.textures = {};
    this.items = [];
  }

  start() {
    this.refresh();
    setInterval(() => { if (!document.hidden) this.refresh(); }, REFRESH_MS);
  }

  async refresh() {
    try {
      const d = await fetchJSON(URL, { timeout: 20000 });
      this.build(d.events || []);
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[eonet]', e);
      this.ctx.ui.sourceError(this.id, 'NASA EONET no responde · reintentando');
    }
  }

  build(events) {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.geometry?.dispose?.();
      if (o.isLine) o.material.dispose();
      if (o.isSprite) o.material.dispose();
    }
    this.items = [];
    const max = this.ctx.isMobile ? 160 : 400;
    for (const ev of events.slice(0, max)) {
      const catId = ev.categories?.[0]?.id;
      const cat = EONET_CATS[catId] || EONET_CATS.manmade;
      const geoms = (ev.geometry || []).filter((g) => g.coordinates);
      if (!geoms.length) continue;
      const last = geoms[geoms.length - 1];
      const pt = pointOf(last);
      if (!pt) continue;
      const pos = latLonToVec3(pt[1], pt[0], 1.006);
      const tex = this.textures[catId] || (this.textures[catId] = icon(cat));
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false }));
      s.position.copy(pos);
      const big = catId === 'severeStorms' || catId === 'volcanoes';
      s.scale.setScalar(big ? 0.028 : catId === 'wildfires' ? 0.012 : 0.02);
      s.renderOrder = 4;
      this.group.add(s);

      // Trayectoria de las tormentas
      if (catId === 'severeStorms' && geoms.length > 1) {
        const pts = geoms.map((g) => pointOf(g)).filter(Boolean).map((p) => latLonToVec3(p[1], p[0], 1.005));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({
          color: cat.color, transparent: true, opacity: 0.7, depthWrite: false,
        }));
        line.renderOrder = 3;
        this.group.add(line);
      }
      const mag = last.magnitudeValue != null ? `${last.magnitudeValue} ${last.magnitudeUnit || ''}`.trim() : '';
      this.items.push({ pos, ev, cat, date: last.date, mag, lat: pt[1], lon: pt[0], catId });
    }
  }

  setVisible(on) { this.visible = on; }

  update() {
    this.group.visible = this.visible && this.ctx.time.live;
  }

  pick(x, y, radius) {
    if (!this.group.visible) return null;
    const { camera, size } = this.ctx;
    const { w, h } = size();
    let best = null;
    for (const it of this.items) {
      const sp = toScreen(it.pos, camera, w, h);
      if (sp.behind) continue;
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > radius + 8 || (best && d >= best.dist)) continue;
      if (isOccluded(it.pos, camera.position)) continue;
      best = { dist: d, it };
    }
    if (!best) return null;
    const { it } = best;
    const src = it.ev.sources?.[0]?.id ? ` · fuente: ${escapeHtml(it.ev.sources[0].id)}` : '';
    return {
      dist: best.dist,
      html: `
        <div class="tt-kicker" style="--c:${it.cat.color}"><span class="tt-dot"></span>${escapeHtml(it.cat.label)} activo</div>
        <div class="tt-title">${escapeHtml(it.ev.title)}</div>
        <div class="tt-meta">Último dato ${escapeHtml(timeAgo(new Date(it.date).getTime()))}${it.mag ? ` · ${escapeHtml(it.mag)}` : ''}${src}</div>`,
    };
  }
}
