// Efectos 3D de la vista de eventos: cortinas de luz sobre los contornos, baliza en el
// epicentro con ondas, focos de calor luminosos, trayectorias en tubo y líneas gruesas.
// Todo se apoya en el relieve real (alturas de las teselas) y se re-asienta cuando llegan.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { latLonToVec3 } from '../geo.js';

const R_M = 6371000;
export const fxClock = { value: 0 };   // segundos reales (animaciones)
const lineMats = new Set();             // necesitan la resolución de pantalla

/** Altura del terreno en unidades del globo (radio 1), ya exagerada como la dibujan las teselas. */
export function groundAt(tiles, lat, lon) {
  if (!tiles?.terrainOn) return 0;
  return (tiles.heightAt(lat, lon) * tiles.exag.value) / R_M;
}

export function setLineResolution(w, h) { for (const m of lineMats) m.resolution.set(w, h); }

/** Línea gruesa con antialias (en píxeles), para contornos 3D de zonas grandes. */
export function thickLine(points, { color, width = 2.5, opacity = 0.95, dashed = false, closed = false }) {
  const pts = closed ? [...points, points[0]] : points;
  const geo = new LineGeometry();
  geo.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
  const mat = new LineMaterial({
    color, linewidth: width, transparent: true, opacity, depthWrite: false,
    dashed, dashSize: 0.012, gapSize: 0.008, worldUnits: false,
  });
  if (dashed) mat.defines.USE_DASH = '';
  mat.resolution.set(innerWidth, innerHeight);
  lineMats.add(mat);
  mat.addEventListener('dispose', () => lineMats.delete(mat));
  const line = new Line2(geo, mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 5;
  line.frustumCulled = false;
  return line;
}

/** Densifica un anillo lon/lat para que la cortina siga el relieve (paso máx. en grados). */
function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Cortina de luz: pared vertical translúcida que nace del suelo y se desvanece hacia arriba
// ---------------------------------------------------------------------------------
const wallMat = (color, opacity) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uTime: fxClock },
  vertexShader: /* glsl */`
    attribute float aV;
    varying float vV;
    void main() { vV = aV; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
    varying float vV;
    void main() {
      float a = pow(1.0 - vV, 2.2);
      float band = exp(-pow((fract(vV * 1.3 - uTime * 0.18) - 0.5) * 7.0, 2.0)) * 0.35 * (1.0 - vV);
      float rim = smoothstep(0.06, 0.0, vV) * 0.8;
      gl_FragColor = vec4(uColor * (a + band + rim) * uOpacity, 1.0);
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
});

export function wallObject(polys, { color, height, opacity = 0.55, tiles }) {
  const rings = polys.map((p) => p.outer);
  let span = 0;
  for (const r of rings) for (const [x, y] of r) span = Math.max(span, Math.abs(x - r[0][0]), Math.abs(y - r[0][1]));
  const step = Math.max(span / 160, 0.002);
  const dirs = [];
  const idx = [];
  const vs = [];
  for (const r of rings) {
    const d = densify(r, step);
    const base = dirs.length;
    for (const [lon, lat] of d) {
      const v = latLonToVec3(lat, lon, 1);
      dirs.push({ v, lat, lon }, { v, lat, lon });
      vs.push(0, 1);
    }
    const n = d.length;
    for (let i = 0; i < n; i++) {
      const a = base + i * 2, b = base + ((i + 1) % n) * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const pos = new Float32Array(dirs.length * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aV', new THREE.BufferAttribute(new Float32Array(vs), 1));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, wallMat(color, opacity));
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  const sink = height * 0.04;
  mesh.userData.reground = () => {
    for (let i = 0; i < dirs.length; i += 2) {
      const { v, lat, lon } = dirs[i];
      const g = groundAt(tiles, lat, lon);
      v.toArray(pos, i * 3); pos[i * 3] *= 1 + g - sink; pos[i * 3 + 1] *= 1 + g - sink; pos[i * 3 + 2] *= 1 + g - sink;
      v.toArray(pos, i * 3 + 3); pos[i * 3 + 3] *= 1 + g + height; pos[i * 3 + 4] *= 1 + g + height; pos[i * 3 + 5] *= 1 + g + height;
    }
    geo.attributes.position.needsUpdate = true;
  };
  mesh.userData.reground();
  return mesh;
}

// ---------------------------------------------------------------------------------
// Baliza: haz de luz vertical + ondas que se expanden por el suelo
// ---------------------------------------------------------------------------------
export function beaconObject({ color, size, tiles, rings = true, ringScale = 1 }) {
  const g = new THREE.Group();
  const col = new THREE.Color(color);
  const H = size * 0.22, Rb = size * 0.005;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(Rb * 0.35, Rb, H, 24, 1, true).translate(0, H / 2, 0),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: col }, uH: { value: H }, uTime: fxClock },
      vertexShader: /* glsl */`
        uniform float uH; varying float vV; varying float vF;
        void main() {
          vV = position.y / uH;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vF = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uTime; varying float vV; varying float vF;
        void main() {
          float a = pow(1.0 - vV, 1.6) * pow(vF, 1.5);
          a *= 0.85 + 0.15 * sin(uTime * 3.0 - vV * 12.0);
          gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.45 * vF) * a, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  beam.renderOrder = 8;
  g.add(beam);

  const R = size * 0.2 * ringScale;
  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(R * 2, R * 2).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: col }, uTime: fxClock, uOn: { value: 1 }, uRings: { value: rings ? 1 : 0 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uTime; uniform float uOn; uniform float uRings; varying vec2 vUv;
        void main() {
          float d = length(vUv * 2.0 - 1.0);
          float a = exp(-d * d * 220.0) * 1.4 + exp(-d * d * 30.0) * 0.25;
          for (int i = 0; i < 3; i++) {
            float ph = fract(uTime * 0.28 + float(i) / 3.0);
            a += uRings * exp(-pow((d - ph) * 30.0, 2.0)) * (1.0 - ph) * (1.0 - ph) * 0.9;
          }
          a *= smoothstep(1.0, 0.9, d) * uOn;
          gl_FragColor = vec4(mix(uColor, vec3(1.0), exp(-d * 40.0)) * a, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }),
  );
  disc.renderOrder = 7;
  g.add(disc);
  g.frustumCulled = false;
  g.traverse((o) => { o.frustumCulled = false; });

  let lat0 = 0, lon0 = 0;
  const up = new THREE.Vector3(0, 1, 0);
  g.userData.place = (lat, lon) => {
    lat0 = lat; lon0 = lon;
    const n = latLonToVec3(lat, lon, 1);
    g.position.copy(n).multiplyScalar(1 + groundAt(tiles, lat, lon) + size * 0.0015);
    g.quaternion.setFromUnitVectors(up, n);
  };
  g.userData.reground = () => g.userData.place(lat0, lon0);
  g.userData.setRings = (on) => { disc.material.uniforms.uRings.value = on ? 1 : 0; };
  return g;
}

// ---------------------------------------------------------------------------------
// Focos de calor: puntos luminosos sobre el terreno, coloreados por antigüedad en el shader
// ---------------------------------------------------------------------------------
export function hotspotsObject(dets, { tiles, t0 }) {
  const n = dets.length;
  const pos = new Float32Array(n * 3), aT = new Float32Array(n), aF = new Float32Array(n);
  dets.forEach((p, i) => { aT[i] = (p.t - t0) / 1000; aF[i] = Math.min(1, Math.sqrt(Math.max(0, p.frp || 0)) / 12); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aF', new THREE.BufferAttribute(aF, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNow: { value: 0 }, uScale: { value: 800 }, uTime: fxClock, uOld: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float aT; attribute float aF;
      uniform float uNow; uniform float uScale; uniform float uTime; uniform float uOld;
      varying vec3 vCol; varying float vA;
      void main() {
        float age = (uNow - aT) / 86400.0;
        vA = age < 0.0 ? 0.0 : 1.0;
        vec3 c0 = vec3(1.0, 0.36, 0.1), c1 = vec3(1.0, 0.54, 0.24), c2 = vec3(0.78, 0.33, 0.23), c3 = vec3(0.48, 0.23, 0.18);
        vCol = age < 1.0 ? mix(vec3(1.0, 0.7, 0.35), c0, smoothstep(0.0, 0.15, age)) : age < 2.0 ? c1 : age < 3.0 ? c2 : c3;
        float fresh = age < 1.0 ? 1.0 : uOld < 0.5 ? 0.0 : age < 2.0 ? 0.55 : age < 3.0 ? 0.3 : 0.16;
        float flick = age < 1.0 ? 0.8 + 0.2 * sin(uTime * 11.0 + aT * 0.37) : 1.0;
        vA *= fresh * flick * (0.4 + 0.45 * aF);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sz = age < 1.0 ? 1.0 : age < 3.0 ? 0.75 : 0.55;
        gl_PointSize = clamp(0.00016 * (0.8 + aF) * sz * uScale / -mv.z, 2.5, 42.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vA;
      void main() {
        if (vA <= 0.0) discard;
        float d = length(gl_PointCoord * 2.0 - 1.0);
        float a = (exp(-d * d * 5.0) * 0.7 + exp(-d * d * 40.0)) * smoothstep(1.0, 0.7, d);
        gl_FragColor = vec4(mix(vCol, vec3(1.0, 0.9, 0.7), exp(-d * d * 30.0) * 0.4) * a * vA, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = 9;
  pts.frustumCulled = false;
  pts.userData.reground = () => {
    const v = new THREE.Vector3();
    dets.forEach((p, i) => latLonToVec3(p.lat, p.lon, 1 + groundAt(tiles, p.lat, p.lon) + 0.000004, v).toArray(pos, i * 3));
    geo.attributes.position.needsUpdate = true;
  };
  pts.userData.reground();
  pts.userData.setTime = (t) => { mat.uniforms.uNow.value = (t - t0) / 1000; };
  pts.userData.setScale = (s) => { mat.uniforms.uScale.value = s; };
  pts.userData.setShowOld = (on) => { mat.uniforms.uOld.value = on ? 1 : 0; };
  return pts;
}

// ---------------------------------------------------------------------------------
// Trayectoria en tubo luminoso (ciclones). setProgress(n) muestra los n primeros puntos.
// ---------------------------------------------------------------------------------
export function tubeObject(points, { color, radius, opacity = 0.9, alt }) {
  const K = 10, RAD = 8;
  if (points.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(points.map((p) => latLonToVec3(p.lat, p.lon, 1 + alt)), false, 'centripetal');
  const geo = new THREE.TubeGeometry(curve, (points.length - 1) * K, radius, RAD, false);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  mesh.userData.setProgress = (n) => geo.setDrawRange(0, Math.floor(Math.max(0, n - 1) * K) * RAD * 6); // n puede ser fraccionario
  return mesh;
}
