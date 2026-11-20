// Capa: viento animado con partículas (Open-Meteo, sin clave; CC BY 4.0).
// Se pide una rejilla global de 15° (264 puntos) una vez por hora como mucho
// (caché en localStorage) y miles de partículas siguen el campo interpolado.
import * as THREE from 'three';
import { latLonToVec3 } from '../geo.js';
import { fetchJSON } from '../net.js';

const STEP = 15;
const LATS = Array.from({ length: 11 }, (_, i) => -75 + i * STEP); // -75..75
const LONS = Array.from({ length: 24 }, (_, i) => -180 + i * STEP); // -180..165
const CACHE_MS = 60 * 60 * 1000;
const TRAIL = 8;
const R = 1.006;
const SPEED = 0.6; // grados por segundo por cada m/s (muy acelerado para que se vea)
const TRAIL_DT = 0.06; // cada cuánto se guarda un punto de la estela

function cached() {
  try {
    const c = JSON.parse(localStorage.getItem('planeta.wind') || 'null');
    return c && Date.now() - c.t < CACHE_MS ? c : null;
  } catch { return null; }
}

export class WindLayer {
  id = 'wind';
  name = 'Viento';

  constructor(ctx) {
    this.ctx = ctx;
    this.visible = false;
    this.u = null; this.v = null;
    this.n = ctx.isMobile ? 1800 : 4500;
    this.fade = 0;
    this.started = false;
    this.build();
  }

  build() {
    const n = this.n;
    this.lat = new Float32Array(n); this.lon = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.hist = new Float32Array(n * TRAIL * 3); // estela en coordenadas de escena
    this.speed = new Float32Array(n);
    const segs = n * (TRAIL - 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2.1;
    this.lines.visible = false;
    this.ctx.scene.add(this.lines);
  }

  start() { /* se carga al activarse por primera vez */ }

  setVisible(on) {
    this.visible = on;
    if (on && !this.started) { this.started = true; this.load(); }
  }

  async load() {
    const c = cached();
    if (c) { this.setGrid(c.u, c.v); this.ctx.ui.sourceOk(this.id); return; }
    const lat = [], lon = [];
    for (const la of LATS) for (const lo of LONS) { lat.push(la); lon.push(lo); }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.join(',')}&longitude=${lon.join(',')}`
      + '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms';
    try {
      const res = await fetchJSON(url, { timeout: 20000 });
      const arr = Array.isArray(res) ? res : [res];
      const u = [], v = [];
      for (const r of arr) {
        const s = r.current?.wind_speed_10m ?? 0;
        const d = ((r.current?.wind_direction_10m ?? 0) * Math.PI) / 180; // de dónde sopla
        u.push(-s * Math.sin(d)); v.push(-s * Math.cos(d));
      }
      if (u.length !== LATS.length * LONS.length) throw new Error('rejilla incompleta');
      try { localStorage.setItem('planeta.wind', JSON.stringify({ t: Date.now(), u, v })); } catch { /* */ }
      this.setGrid(u, v);
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[wind]', e);
      this.ctx.ui.sourceError(this.id, 'No se pudo cargar el viento · se reintentará');
      setTimeout(() => this.load(), 10 * 60 * 1000);
    }
    // refresco horario
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.load(), CACHE_MS + 5000);
  }

  setGrid(u, v) {
    this.u = Float32Array.from(u); this.v = Float32Array.from(v);
    for (let i = 0; i < this.n; i++) this.respawn(i, true);
  }

  /** Viento interpolado (m/s) en lat/lon. */
  sample(lat, lon, out) {
    const fy = (THREE.MathUtils.clamp(lat, -75, 75) + 75) / STEP;
    const fx = (((lon + 180) % 360) + 360) % 360 / STEP;
    const y0 = Math.min(Math.floor(fy), LATS.length - 2), x0 = Math.floor(fx) % LONS.length;
    const x1 = (x0 + 1) % LONS.length, ty = fy - y0, tx = fx - Math.floor(fx);
    const idx = (y, x) => y * LONS.length + x;
    const lerp2 = (a) => {
      const a00 = a[idx(y0, x0)], a10 = a[idx(y0, x1)], a01 = a[idx(y0 + 1, x0)], a11 = a[idx(y0 + 1, x1)];
      return (a00 * (1 - tx) + a10 * tx) * (1 - ty) + (a01 * (1 - tx) + a11 * tx) * ty;
    };
    out[0] = lerp2(this.u); out[1] = lerp2(this.v);
    return out;
  }

  respawn(i, randomAge = false) {
    // Uniforme sobre la esfera, sin polos extremos
    this.lat[i] = (Math.asin(Math.random() * 2 - 1) * 180) / Math.PI * 0.92;
    this.lon[i] = Math.random() * 360 - 180;
    this.life[i] = 3 + Math.random() * 5;
    this.age[i] = randomAge ? Math.random() * this.life[i] : 0;
    const v = latLonToVec3(this.lat[i], this.lon[i], R);
    for (let k = 0; k < TRAIL; k++) this.hist.set([v.x, v.y, v.z], (i * TRAIL + k) * 3);
  }

  update(dt) {
    const target = this.visible && this.u ? 1 : 0;
    this.fade += (target - this.fade) * Math.min(1, dt * 2);
    const h = this.ctx.camera.position.length() - 1;
    const zoomFade = THREE.MathUtils.smoothstep(h, 0.08, 0.4);
    const alpha = this.fade * zoomFade;
    this.lines.visible = alpha > 0.01;
    if (!this.lines.visible) return;
    this.lines.material.opacity = 0.9 * alpha;

    const w = [0, 0];
    const v = new THREE.Vector3();
    dt = Math.min(dt, 0.05);
    this.acc = (this.acc || 0) + dt;
    const shift = this.acc >= TRAIL_DT;
    if (shift) this.acc = 0;
    const pos = this.lines.geometry.attributes.position.array;
    const col = this.lines.geometry.attributes.color.array;
    let p = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > this.life[i]) this.respawn(i);
      this.sample(this.lat[i], this.lon[i], w);
      const s = Math.hypot(w[0], w[1]);
      this.speed[i] = s;
      this.lat[i] += w[1] * SPEED * dt;
      this.lon[i] += (w[0] * SPEED * dt) / Math.max(0.2, Math.cos((this.lat[i] * Math.PI) / 180));
      if (this.lat[i] > 80 || this.lat[i] < -80) { this.respawn(i); continue; }
      if (this.lon[i] > 180) this.lon[i] -= 360;
      if (this.lon[i] < -180) this.lon[i] += 360;
      // desplaza la estela y añade la cabeza
      const base = i * TRAIL * 3;
      if (shift) this.hist.copyWithin(base, base + 3, base + TRAIL * 3);
      latLonToVec3(this.lat[i], this.lon[i], R, v);
      this.hist[base + (TRAIL - 1) * 3] = v.x; this.hist[base + (TRAIL - 1) * 3 + 1] = v.y; this.hist[base + (TRAIL - 1) * 3 + 2] = v.z;
      // color por velocidad: azul suave → blanco → ámbar
      const t = Math.min(1, s / 18);
      const life = Math.min(1, this.age[i] / 0.6, (this.life[i] - this.age[i]) / 0.8);
      const cr = 0.35 + 0.65 * t, cg = 0.6 + 0.3 * t, cb = 1.0 - 0.5 * t * t;
      for (let k = 0; k < TRAIL - 1; k++) {
        const a0 = (k / (TRAIL - 1)) * life * 0.8, a1 = ((k + 1) / (TRAIL - 1)) * life * 0.8;
        const h0 = base + k * 3, h1 = base + (k + 1) * 3;
        pos[p] = this.hist[h0]; pos[p + 1] = this.hist[h0 + 1]; pos[p + 2] = this.hist[h0 + 2];
        col[p] = cr * a0; col[p + 1] = cg * a0; col[p + 2] = cb * a0;
        pos[p + 3] = this.hist[h1]; pos[p + 4] = this.hist[h1 + 1]; pos[p + 5] = this.hist[h1 + 2];
        col[p + 3] = cr * a1; col[p + 4] = cg * a1; col[p + 5] = cb * a1;
        p += 6;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  /** Viento en un punto: velocidad (km/h) y de dónde sopla. */
  at(lat, lon) {
    if (!this.u) return null;
    const w = this.sample(lat, lon, [0, 0]);
    const kmh = Math.hypot(w[0], w[1]) * 3.6;
    const from = ((Math.atan2(-w[0], -w[1]) * 180) / Math.PI + 360) % 360;
    return { kmh, from };
  }
}
