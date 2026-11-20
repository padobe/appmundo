// Capa: satélites en órbita en directo (CelesTrak + SGP4 en un Web Worker).
// Grupos activables por separado para no saturar la vista. CelesTrak pide no
// descargar el mismo grupo más de una vez cada 2 h → caché en localStorage.
import * as THREE from 'three';
import { EARTH_RADIUS_KM, toScreen, isOccluded } from '../geo.js';
import { escapeHtml } from '../net.js';

const TLE_URL = (g) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;
const CACHE_MS = 2 * 3600 * 1000;

export const SAT_GROUPS = {
  visual: { label: 'Brillantes', sources: ['stations', 'visual'], color: '#ffffff', size: 2.6, on: true },
  gnss: { label: 'GPS y navegación', sources: ['gnss'], color: '#8affc1', size: 2.4, on: true },
  geo: { label: 'Geoestacionarios', sources: ['geo'], color: '#ffc46b', size: 2.2, on: true },
  starlink: { label: 'Starlink', sources: ['starlink'], color: '#9ec9ff', size: 1.4, on: false },
};

const vertex = /* glsl */ `
  attribute vec3 aB;
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uF;
  uniform float uPixelRatio;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vec3 p = mix(position, aB, uF);
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * uScale;
    if (dot(p, p) < 0.01) gl_PointSize = 0.0; // sin datos
  }
`;
const fragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.2, r);
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, a * 0.9);
    #include <colorspace_fragment>
  }
`;

function readCache(src) {
  try {
    const c = JSON.parse(localStorage.getItem(`planeta.tle.${src}`) || 'null');
    return c && typeof c.text === 'string' ? c : null;
  } catch { return null; }
}
function writeCache(src, text) {
  try { localStorage.setItem(`planeta.tle.${src}`, JSON.stringify({ t: Date.now(), text })); } catch { /* sin espacio: no pasa nada */ }
}

export class SatellitesLayer {
  id = 'sats';
  name = 'Satélites';

  constructor(ctx) {
    this.ctx = ctx;
    this.visible = true;
    this.enabled = Object.fromEntries(Object.entries(SAT_GROUPS).map(([k, g]) => [k, g.on]));
    this.texts = {};
    this.meta = null;
    this.uniforms = { uF: { value: 0 }, uPixelRatio: { value: ctx.renderer.getPixelRatio() }, uScale: { value: 1 } };
    this.points = null;
    this.t0 = 0;
    this.step = 2000;
    this.passWaiters = new Map();
    this.worker = new Worker(new URL('../workers/satellites.worker.js', import.meta.url));
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => { console.warn('[sats] worker', e); this.ctx.ui.sourceError(this.id, 'No se pudieron calcular las órbitas'); };
    this.lastTick = 0;
  }

  start() { this.sync(); }

  setVisible(on) { this.visible = on; if (on) this.sync(); }
  setGroup(key, on) { this.enabled[key] = on; this.sync(); }

  /** Fuentes de CelesTrak necesarias (la estación espacial siempre, para los pasos de la ISS). */
  sources() {
    const set = new Set(['stations']);
    if (this.visible) for (const [k, g] of Object.entries(SAT_GROUPS)) if (this.enabled[k]) g.sources.forEach((s) => set.add(s));
    return [...set];
  }

  /** Agrupa cambios seguidos (p. ej. al iniciar los interruptores) en una sola sincronización. */
  sync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.doSync(), 80);
  }

  /** Descarga un grupo una sola vez aunque se pida varias veces a la vez. */
  fetchSource(src) {
    this.loading ||= {};
    if (!this.loading[src]) {
      this.loading[src] = this.download(src).finally(() => { delete this.loading[src]; });
    }
    return this.loading[src];
  }

  async download(src) {
    const cached = readCache(src);
    if (cached && Date.now() - cached.t < CACHE_MS) { this.texts[src] = cached.text; return true; }
    try {
      const res = await fetch(TLE_URL(src), { signal: AbortSignal.timeout(25000) });
      const text = await res.text();
      if (!res.ok || !text.includes('\n1 ')) throw new Error(`HTTP ${res.status}`);
      this.texts[src] = text;
      writeCache(src, text);
      return true;
    } catch (e) {
      console.warn('[sats]', src, e);
      if (cached) { this.texts[src] = cached.text; return true; } // de más de 2 h: siguen sirviendo
      // Último recurso: copia incluida en la web (scripts/update-tle.mjs)
      try {
        const r = await fetch(`./assets/sky/tle/${src}.txt`);
        const text = await r.text();
        if (r.ok && text.includes('\n1 ')) { this.texts[src] = text; this.backup = true; return true; }
      } catch { /* sin copia */ }
      return false;
    }
  }

  async doSync() {
    const srcs = this.sources();
    let failed = false;
    await Promise.all(srcs.map(async (src) => {
      if (this.texts[src]) return;
      if (!(await this.fetchSource(src))) failed = true;
    }));
    if (failed) this.ctx.ui.sourceError(this.id, 'CelesTrak no responde · reintentando más tarde');
    else this.ctx.ui.sourceOk(this.id);
    if (failed && !this.retry) this.retry = setTimeout(() => { this.retry = null; this.sync(); }, 15 * 60 * 1000);

    // Grupo de cada fuente para colorear (stations se muestra como "Brillantes")
    const groups = {};
    for (const src of this.sources()) {
      if (!this.texts[src]) continue;
      const owner = Object.entries(SAT_GROUPS).find(([, g]) => g.sources.includes(src))?.[0];
      const shown = this.visible && owner && this.enabled[owner];
      groups[shown ? `${owner}:${src}` : `hidden:${src}`] = this.texts[src];
    }
    this.worker.postMessage({ type: 'groups', groups });
  }

  onWorker(msg) {
    if (msg.type === 'meta') {
      this.meta = msg;
      this.buildPoints(msg);
      this.lastTick = 0;
    } else if (msg.type === 'pos') {
      if (!this.points || msg.a.length !== this.points.geometry.attributes.position.array.length) return;
      const g = this.points.geometry;
      g.attributes.position.array.set(msg.a);
      g.attributes.aB.array.set(msg.b);
      g.attributes.position.needsUpdate = true;
      g.attributes.aB.needsUpdate = true;
      this.posA = msg.a; this.posB = msg.b;
      this.t0 = msg.t;
      this.step = msg.step;
    } else if (msg.type === 'passes') {
      this.passWaiters.get(msg.id)?.(msg.passes);
      this.passWaiters.delete(msg.id);
    }
  }

  buildPoints({ groups }) {
    if (this.points) {
      this.ctx.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    const n = groups.length;
    const col = new Float32Array(n * 3), size = new Float32Array(n);
    const c = new THREE.Color();
    groups.forEach((g, i) => {
      const key = g.split(':')[0];
      const def = SAT_GROUPS[key];
      if (!def) { size[i] = 0; return; }
      c.set(def.color).convertSRGBToLinear();
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = def.size * (this.ctx.isMobile ? 0.9 : 1);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aB', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.ctx.scene.add(this.points);
    this.posA = this.posB = null;
  }

  update() {
    if (!this.points) return;
    const { time, camera } = this.ctx;
    const show = this.visible && time.live;
    this.points.visible = show;
    if (!show) return;
    const now = Date.now();
    if (now - this.lastTick > this.step - 150) {
      this.lastTick = now;
      this.worker.postMessage({ type: 'tick', t: now });
    }
    this.uniforms.uF.value = THREE.MathUtils.clamp((now - this.t0) / this.step, 0, 1.3);
    const h = camera.position.length() - 1;
    this.uniforms.uScale.value = THREE.MathUtils.clamp(0.7 + h * 0.15, 0.7, 1.3);
  }

  /** Próximos pasos de la ISS sobre un punto (los calcula el worker). */
  issPasses(lat, lon, hours = 72) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      this.passWaiters.set(id, resolve);
      this.worker.postMessage({ type: 'passes', id, lat, lon, from: Date.now(), hours });
      setTimeout(() => { if (this.passWaiters.delete(id)) resolve(null); }, 15000);
    });
  }

  pick(x, y, radius) {
    if (!this.points?.visible || !this.posA || !this.meta) return null;
    const { camera, size } = this.ctx;
    const { w, h } = size();
    const f = this.uniforms.uF.value;
    const p = new THREE.Vector3();
    const sizes = this.points.geometry.attributes.aSize.array;
    let best = null;
    for (let i = 0; i < this.meta.names.length; i++) {
      if (!sizes[i]) continue;
      const k = i * 3;
      p.set(
        this.posA[k] + (this.posB[k] - this.posA[k]) * f,
        this.posA[k + 1] + (this.posB[k + 1] - this.posA[k + 1]) * f,
        this.posA[k + 2] + (this.posB[k + 2] - this.posA[k + 2]) * f,
      );
      if (p.lengthSq() < 0.01) continue;
      const sp = toScreen(p, camera, w, h);
      if (sp.behind) continue;
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > radius * 0.9 || (best && d >= best.dist)) continue;
      if (isOccluded(p, camera.position)) continue;
      best = { dist: d, i, alt: (p.length() - 1) * EARTH_RADIUS_KM };
    }
    if (!best) return null;
    const key = this.meta.groups[best.i].split(':')[0];
    const def = SAT_GROUPS[key];
    const orbit = best.alt > 30000 ? 'Órbita geoestacionaria' : best.alt > 2000 ? 'Órbita media' : 'Órbita baja';
    return {
      dist: best.dist + 1,
      html: `
        <div class="tt-kicker" style="--c:${def.color}"><span class="tt-dot"></span>Satélite · ${escapeHtml(def.label)}</div>
        <div class="tt-title">${escapeHtml(this.meta.names[best.i])}</div>
        <div class="tt-meta">${Math.round(best.alt).toLocaleString('es-ES')} km de altitud · ${orbit}${this.backup ? ' · posición aproximada (datos de respaldo)' : ''}</div>`,
    };
  }
}
