// Capa: terremotos de las últimas 24 h (USGS). Todos los pulsos son un único
// InstancedMesh con un shader de ondas → una sola llamada de dibujo.
import * as THREE from 'three';
import { latLonToVec3, toScreen, isOccluded } from '../geo.js';
import { fetchJSON, escapeHtml, timeAgo } from '../net.js';

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const REFRESH_MS = 5 * 60 * 1000;

export const MAG_COLORS = [
  { min: -Infinity, color: '#4fd1c5', label: '< 2.5' },
  { min: 2.5, color: '#f6d860', label: '2.5 – 4.5' },
  { min: 4.5, color: '#ff8a3d', label: '4.5 – 6' },
  { min: 6, color: '#ff3d6e', label: '≥ 6' },
];
const colorFor = (m) => [...MAG_COLORS].reverse().find((c) => m >= c.min).color;

const vertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aAge;
  attribute float aRing;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vPhase;
  varying float vAge;
  varying float vRing;
  void main() {
    vUv = uv;
    vColor = aColor; vPhase = aPhase; vAge = aAge; vRing = aRing;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vPhase;
  varying float vAge;
  varying float vRing;

  float ring(float r, float t) {
    return smoothstep(0.075, 0.0, abs(r - t)) * pow(1.0 - t, 1.4);
  }

  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float speed = mix(0.55, 0.28, vRing);
    float t1 = fract(uTime * speed + vPhase);
    float t2 = fract(t1 + 0.5);
    float rings = max(ring(r, t1), ring(r, t2)) * vRing;
    float core = smoothstep(0.13, 0.04, r);
    float glow = exp(-r * r * 18.0) * 0.55;
    float fresh = mix(1.0, 0.5, vAge);
    float a = (rings * 0.95 + core + glow) * fresh;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

function placeEs(p) {
  if (!p) return 'Ubicación desconocida';
  const m = p.match(/^(\d+(?:\.\d+)?) ?km ([NSEW]{1,3}) of (.+)$/);
  if (m) return `A ${m[1]} km al ${m[2].replace(/W/g, 'O')} de ${m[3]}`;
  const DIRS = { north: 'norte', south: 'sur', east: 'este', west: 'oeste', northeast: 'noreste', northwest: 'noroeste', southeast: 'sureste', southwest: 'suroeste' };
  const d = p.match(/^(north|south|east|west|northeast|northwest|southeast|southwest) of (?:the )?(.+)$/i);
  return d ? `Al ${DIRS[d[1].toLowerCase()]} de ${d[2]}` : p;
}
const regionOf = (p) => (p?.includes(',') ? p.split(',').pop().trim() : placeEs(p).replace(/^A \S+ km al \S+ de /, ''));
// (si no hay coma, p. ej. "Al sureste de Loyalty Islands", se muestra la frase completa)

export class EarthquakesLayer {
  id = 'quakes';
  name = 'USGS';

  constructor(ctx) {
    this.ctx = ctx;
    this.max = ctx.isMobile ? 400 : 900;
    this.items = [];
    this.seen = null;
    this.mesh = null;
    this.uniforms = { uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.lastSubUpdate = 0;
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
  }

  async refresh() {
    try {
      const data = await fetchJSON(FEED);
      this.setData(data.features || []);
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[quakes]', e);
      this.ctx.ui.sourceError(this.id, this.items.length
        ? 'USGS no responde · mostrando los últimos datos'
        : 'No se pudieron cargar los terremotos · reintentando en 5 min');
    }
  }

  setData(features) {
    const now = Date.now();
    const all = features
      .filter((f) => f.geometry?.coordinates && f.properties?.mag != null)
      .map((f) => {
        const [lon, lat, depth] = f.geometry.coordinates;
        const p = f.properties;
        return { id: f.id, lat, lon, depth, mag: p.mag, place: p.place, time: p.time, url: p.url };
      });

    // Avisos de terremotos nuevos y relevantes (no en la primera carga)
    if (this.seen) {
      const fresh = all.filter((q) => !this.seen.has(q.id) && q.mag >= 4.5)
        .sort((a, b) => b.mag - a.mag)[0];
      if (fresh) this.ctx.ui.toast(`Nuevo terremoto M ${fresh.mag.toFixed(1)} · ${placeEs(fresh.place)}`, 'info');
    }
    this.seen = new Set(all.map((q) => q.id));

    this.total = all.length;
    this.strongest = all.reduce((a, b) => (!a || b.mag > a.mag ? b : a), null);
    this.latest = all.reduce((a, b) => (!a || b.time > a.time ? b : a), null);

    const items = [...all].sort((a, b) => b.mag - a.mag).slice(0, this.max);
    this.items = items;
    this.build(items, now);
    this.updateStats(true);
  }

  build(items, now) {
    if (this.mesh) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.dispose();
    }
    const n = items.length;
    const geo = this.geometry.clone();
    const color = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const age = new Float32Array(n);
    const ringAmp = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(geo, this.material, Math.max(n, 1));
    mesh.count = n;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;

    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1), s = new THREE.Vector3(), nrm = new THREE.Vector3();
    const c = new THREE.Color();

    items.forEach((it, i) => {
      const mag = Math.max(it.mag, 0);
      const size = 0.022 + 0.0062 * Math.pow(mag, 1.7);
      const r = 1.003 + size * size * 0.5;
      it.pos = latLonToVec3(it.lat, it.lon, r);
      nrm.copy(it.pos).normalize();
      q.setFromUnitVectors(Z, nrm);
      s.set(size, size, size);
      m.compose(it.pos, q, s);
      mesh.setMatrixAt(i, m);
      c.set(colorFor(it.mag)).convertSRGBToLinear();
      color.set([c.r, c.g, c.b], i * 3);
      phase[i] = Math.random();
      age[i] = THREE.MathUtils.clamp((now - it.time) / 86400000, 0, 1);
      ringAmp[i] = THREE.MathUtils.clamp((it.mag - 1.2) / 3, 0.2, 1);
    });

    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aAge', new THREE.InstancedBufferAttribute(age, 1));
    geo.setAttribute('aRing', new THREE.InstancedBufferAttribute(ringAmp, 1));
    mesh.instanceMatrix.needsUpdate = true;
    this.mesh = mesh;
    this.ctx.scene.add(mesh);
  }

  updateStats(force = false) {
    const now = performance.now();
    if (!force && now - this.lastSubUpdate < 20000) return;
    this.lastSubUpdate = now;
    const { ui } = this.ctx;
    if (this.total == null) return;
    ui.set('q-count', this.total.toLocaleString('es-ES'));
    const parts = [];
    if (this.strongest) parts.push(`Mayor: M ${this.strongest.mag.toFixed(1)} · ${regionOf(this.strongest.place)}`);
    if (this.latest) parts.push(`Último ${timeAgo(this.latest.time)}`);
    ui.set('q-sub', parts.join('\n'));
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
    this.updateStats();
  }

  pick(x, y, radius) {
    const { camera, size } = this.ctx;
    const { w, h } = size();
    let best = null;
    for (const it of this.items) {
      if (!it.pos) continue;
      const sp = toScreen(it.pos, camera, w, h);
      if (sp.behind) continue;
      const d = Math.hypot(sp.x - x, sp.y - y);
      const r = radius + Math.min(10, it.mag * 1.5);
      if (d > r) continue;
      if (isOccluded(it.pos, camera.position)) continue;
      const score = d - it.mag * 2;
      if (!best || score < best.score) best = { score, dist: d, it };
    }
    if (!best) return null;
    const it = best.it;
    const col = colorFor(it.mag);
    return {
      dist: best.dist,
      html: `
        <div class="tt-kicker" style="--c:${col}"><span class="tt-dot"></span>Terremoto · M ${it.mag.toFixed(1)}</div>
        <div class="tt-title">${escapeHtml(placeEs(it.place))}</div>
        <div class="tt-meta">${escapeHtml(timeAgo(it.time))} · ${Math.round(it.depth ?? 0)} km de profundidad</div>`,
    };
  }
}
