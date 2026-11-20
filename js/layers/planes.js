// Capa: aviones en vuelo (OpenSky Network, vía data/planes.json que actualiza
// una GitHub Action). Todos los aviones son una sola malla instanciada; su avance
// entre actualizaciones se estima en el shader con su rumbo y velocidad.
import * as THREE from 'three';
import { EARTH_RADIUS_KM, latLonToVec3, toScreen, isOccluded, formatLatLon } from '../geo.js';
import { fetchJSON, escapeHtml, timeAgo } from '../net.js';

const DATA_URL = './data/planes.json';
const REFRESH_MS = 2 * 60 * 1000;
const MAX_EXTRAPOLATION_S = 25 * 60;
const STALE_S = 3 * 3600;
const R_M = EARTH_RADIUS_KM * 1000;
const ALT_EXAGGERATION = 3; // la altitud real (≈11 km) apenas se vería

const vertex = /* glsl */ `
  attribute vec3 aPos;
  attribute float aTrack;
  attribute float aVel;
  attribute float aAlt;
  uniform float uDt;
  uniform float uSize;
  varying float vAlt;
  void main() {
    vec3 up = aPos;
    vec3 east = cross(vec3(0.0, 1.0, 0.0), up);
    east = length(east) < 1e-5 ? vec3(1.0, 0.0, 0.0) : normalize(east);
    vec3 north = cross(up, east);
    vec3 dir = north * cos(aTrack) + east * sin(aTrack);
    // Avance sobre el círculo máximo según su rumbo
    float ang = aVel * uDt;
    vec3 p = up * cos(ang) + dir * sin(ang);
    vec3 fwd = dir * cos(ang) - up * sin(ang);
    vec3 right = cross(fwd, p);
    vec3 world = p * (1.0 + aAlt) + (fwd * position.y + right * position.x) * uSize;
    vAlt = aAlt;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const fragment = /* glsl */ `
  varying float vAlt;
  void main() {
    float k = smoothstep(0.0, 0.0045, vAlt);  // bajos: ámbar · crucero: blanco cálido
    // Blanco frío para no confundirlos con las luces de las ciudades (cálidas)
    vec3 col = mix(vec3(0.55, 0.85, 0.95), vec3(0.9, 0.95, 1.0), k) * 0.8; // bajo el umbral del bloom
    gl_FragColor = vec4(col, 0.9);
    #include <colorspace_fragment>
  }
`;

// Silueta mínima de avión (morro hacia +y)
function planeShape() {
  const g = new THREE.InstancedBufferGeometry();
  const v = [
    0, 1, 0, -0.18, 0.2, 0, 0.18, 0.2, 0, // morro
    -0.18, 0.2, 0, 0.18, 0.2, 0, -0.12, -0.7, 0, // fuselaje
    0.18, 0.2, 0, 0.12, -0.7, 0, -0.12, -0.7, 0,
    -1, -0.15, 0, 1, -0.15, 0, 0, 0.35, 0, // alas
    -0.45, -0.9, 0, 0.45, -0.9, 0, 0, -0.55, 0, // cola
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

export class PlanesLayer {
  id = 'planes';
  name = 'Aviones';

  constructor(ctx) {
    this.ctx = ctx;
    this.uniforms = { uDt: { value: 0 }, uSize: { value: 0.006 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = null;
    this.data = null;
    this.visible = true;
    this.count = 0;
    this.lastT = null;
  }

  start() {
    this.refresh();
    setInterval(() => { if (!document.hidden) this.refresh(); }, REFRESH_MS);
  }

  async refresh() {
    try {
      const d = await fetchJSON(`${DATA_URL}?t=${Math.floor(Date.now() / 60000)}`);
      if (!Array.isArray(d.f)) throw new Error('formato');
      const age = Date.now() / 1000 - d.t;
      if (age > STALE_S) throw new Error(`datos antiguos (${Math.round(age / 3600)} h)`);
      if (d.t !== this.lastT) {
        this.lastT = d.t;
        this.setData(d);
      }
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[planes]', e);
      if (!this.data) this.ctx.ui.set('planes-count', 'sin datos');
      this.ctx.ui.sourceError(this.id, 'Datos de aviones no disponibles ahora mismo');
    }
  }

  setData(d) {
    const max = this.ctx.isMobile ? 6000 : 14000;
    const rows = d.f.length > max ? d.f.filter((_, i) => i % Math.ceil(d.f.length / max) === 0) : d.f;
    const n = rows.length;
    const pos = new Float32Array(n * 3), track = new Float32Array(n), vel = new Float32Array(n), alt = new Float32Array(n);
    const v = new THREE.Vector3();
    rows.forEach((r, i) => {
      latLonToVec3(r[0], r[1], 1, v);
      pos.set([v.x, v.y, v.z], i * 3);
      track[i] = (r[3] * Math.PI) / 180;
      vel[i] = r[4] / R_M; // rad/s
      alt[i] = (Math.max(0, r[2]) / R_M) * ALT_EXAGGERATION;
    });
    const g = planeShape();
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('aTrack', new THREE.InstancedBufferAttribute(track, 1));
    g.setAttribute('aVel', new THREE.InstancedBufferAttribute(vel, 1));
    g.setAttribute('aAlt', new THREE.InstancedBufferAttribute(alt, 1));
    g.instanceCount = n;

    if (this.mesh) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2.5;
    this.ctx.scene.add(this.mesh);
    this.data = { t: d.t, rows, countries: d.c, pos, track, vel, alt };
    this.count = d.f.length;
    this.ctx.ui.set('planes-count', this.count.toLocaleString('es-ES'));
  }

  setVisible(on) { this.visible = on; }

  dt() {
    return this.data ? THREE.MathUtils.clamp(Date.now() / 1000 - this.data.t, 0, MAX_EXTRAPOLATION_S) : 0;
  }

  update() {
    if (!this.mesh) return;
    const show = this.visible && this.ctx.time.live;
    this.mesh.visible = show;
    if (!show) return;
    this.uniforms.uDt.value = this.dt();
    // Tamaño constante en pantalla (~3 px) a cualquier distancia
    const h = this.ctx.camera.position.length() - 1;
    this.uniforms.uSize.value = THREE.MathUtils.clamp(h * 0.0024, 0.00001, 0.005);
  }

  /** Posición estimada ahora mismo (misma fórmula que el shader). */
  currentPos(i, out) {
    const { pos, track, vel, alt } = this.data;
    const up = out.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const east = new THREE.Vector3(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-10) east.set(1, 0, 0); else east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const dir = north.multiplyScalar(Math.cos(track[i])).addScaledVector(east, Math.sin(track[i]));
    const ang = vel[i] * this.dt();
    return up.multiplyScalar(Math.cos(ang)).addScaledVector(dir, Math.sin(ang)).multiplyScalar(1 + alt[i]);
  }

  pick(x, y, radius) {
    if (!this.mesh?.visible || !this.data) return null;
    const { camera, size } = this.ctx;
    const { w, h } = size();
    const p = new THREE.Vector3();
    // Prefiltro barato: solo los aviones en el hemisferio que mira la cámara
    const camDir = camera.position.clone().normalize();
    const minDot = 1 / camera.position.length() - 0.02;
    let best = null;
    const { pos } = this.data;
    for (let i = 0; i < this.data.rows.length; i++) {
      if (pos[i * 3] * camDir.x + pos[i * 3 + 1] * camDir.y + pos[i * 3 + 2] * camDir.z < minDot) continue;
      this.currentPos(i, p);
      const sp = toScreen(p, camera, w, h);
      if (sp.behind) continue;
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > radius * 0.8 || (best && d >= best.dist)) continue;
      if (isOccluded(p, camera.position)) continue;
      best = { dist: d, i, lat: 0, lon: 0 };
    }
    if (!best) return null;
    const r = this.data.rows[best.i];
    const country = this.data.countries[r[6]] || '';
    const ago = timeAgo(this.data.t * 1000);
    return {
      dist: best.dist + 2,
      html: `
        <div class="tt-kicker" style="--c:#bfeaff"><span class="tt-dot"></span>Avión${r[5] ? ` · ${escapeHtml(r[5])}` : ''}</div>
        <div class="tt-title">${escapeHtml(country) || 'En vuelo'}</div>
        <div class="tt-meta">${Math.round(r[2]).toLocaleString('es-ES')} m · ${Math.round(r[4] * 3.6).toLocaleString('es-ES')} km/h · rumbo ${r[3]}°<br>Posición estimada · último dato ${escapeHtml(ago)}<br>${formatLatLon(r[0], r[1])}</div>`,
    };
  }
}
