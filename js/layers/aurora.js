// Capa: auroras en directo (NOAA SWPC, modelo OVATION; dominio público, sin clave).
// La probabilidad de aurora (rejilla 360×181) se convierte en textura y se dibuja como
// un velo luminoso que ondula, solo en la cara nocturna.
import * as THREE from 'three';
import { fetchJSON } from '../net.js';

const URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const REFRESH_MS = 10 * 60 * 1000;

const vertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  uniform float uTime;
  uniform float uFade;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    float p = texture2D(map, vUv).r;            // 0..1 (probabilidad / 100)
    float night = smoothstep(0.08, -0.18, dot(normalize(vNormalW), sunDir));
    if (p < 0.02 || night < 0.01) discard;
    // Cortinas: bandas finas en longitud que se mueven despacio
    float bands = noise(vec2(vUv.x * 220.0 + uTime * 0.25, vUv.y * 18.0 - uTime * 0.05));
    bands = 0.45 + 0.75 * pow(bands, 1.6);
    float flicker = 0.85 + 0.15 * noise(vec2(vUv.x * 40.0, uTime * 0.6));
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float edge = 1.0 + 1.6 * pow(1.0 - abs(dot(N, V)), 2.0);  // más intenso de canto: efecto cortina
    float a = smoothstep(0.02, 0.6, p) * bands * flicker * night * edge * uFade;
    vec3 green = vec3(0.25, 1.0, 0.55);
    vec3 violet = vec3(0.75, 0.3, 1.0);
    vec3 col = mix(green, violet, smoothstep(0.35, 0.9, p) * 0.45);
    gl_FragColor = vec4(col * a, a);
    #include <colorspace_fragment>
  }
`;

export class AuroraLayer {
  id = 'aurora';
  name = 'Auroras';

  constructor(ctx) {
    this.ctx = ctx;
    this.visible = true;
    this.data = null; // Float32Array 360×181 (lon -180.., lat -90..)
    this.tex = new THREE.DataTexture(new Uint8Array(360 * 181), 360, 181, THREE.RedFormat);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.uniforms = {
      map: { value: this.tex },
      sunDir: ctx.earth.uniforms.sunDir,
      uTime: { value: 0 },
      uFade: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vertex, fragmentShader: fragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    // Dos capas a distinta altura (≈100 y ≈200 km) para dar volumen
    this.group = new THREE.Group();
    for (const r of [1.016, 1.03]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 180, 90), mat);
      m.renderOrder = 2.2;
      this.group.add(m);
    }
    this.group.visible = false;
    ctx.scene.add(this.group);
  }

  start() {
    this.refresh();
    setInterval(() => { if (!document.hidden) this.refresh(); }, REFRESH_MS);
  }

  async refresh() {
    try {
      const d = await fetchJSON(URL, { timeout: 20000 });
      const px = new Uint8Array(360 * 181);
      const data = new Float32Array(360 * 181);
      for (const [lon, lat, v] of d.coordinates) {
        const x = ((Math.round(lon) + 180) % 360 + 360) % 360; // 0..359 → columna desde -180°
        const y = Math.round(lat) + 90;
        const val = Math.min(100, Math.max(0, v));
        px[y * 360 + x] = Math.round(val * 2.55);
        data[y * 360 + x] = val;
      }
      this.tex.image.data.set(px);
      this.tex.needsUpdate = true;
      this.data = data;
      this.forecast = d['Forecast Time'];
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[aurora]', e);
      this.ctx.ui.sourceError(this.id, 'NOAA no responde · sin auroras por ahora');
    }
  }

  /** Probabilidad de aurora (%) en un punto. */
  probabilityAt(lat, lon) {
    if (!this.data) return null;
    const x = ((Math.round(lon) + 180) % 360 + 360) % 360;
    return this.data[(Math.round(lat) + 90) * 360 + x];
  }

  /** Punto con más actividad en la cara nocturna (para el tour). */
  strongestAtNight(isNight) {
    if (!this.data) return null;
    let best = null;
    for (let y = 0; y < 181; y++) for (let x = 0; x < 360; x++) {
      const v = this.data[y * 360 + x];
      if (v < 15 || (best && v <= best.v)) continue;
      const lat = y - 90, lon = x - 180;
      if (isNight(lat, lon)) best = { lat, lon, v };
    }
    return best;
  }

  setVisible(on) { this.visible = on; }

  update(dt) {
    this.uniforms.uTime.value += dt;
    const target = this.visible && this.data ? 1 : 0;
    const f = this.uniforms.uFade;
    f.value += (target - f.value) * Math.min(1, dt * 2);
    // En la repetición no hay histórico: se atenúa
    if (!this.ctx.time.live) f.value *= 0.5;
    this.group.visible = f.value > 0.01;
  }
}
