// Efectos ilustrativos de la vista de eventos (se pueden apagar en «Capas»): humo y ceniza
// arrastrados por el viento real, espiral de nubes de ciclón, ondas sísmicas y réplicas.
import * as THREE from 'three';
import { latLonToVec3 } from '../geo.js';
import { fxClock, groundAt } from './fx.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Este y norte locales en un punto de la esfera. */
function frameAt(n) {
  const east = new THREE.Vector3().crossVectors(UP, n).normalize();
  const north = new THREE.Vector3().crossVectors(n, east);
  return { east, north };
}

// ---------------------------------------------------------------------------------
// Humo / ceniza: partículas animadas en el shader (sin coste de CPU por fotograma)
// sources: [{ lat, lon, w }] · windFrom: grados desde donde sopla · windKmh
// ---------------------------------------------------------------------------------
export function plumeObject(sources, { tiles, windFrom = 0, windKmh = 10, height, color = [0.42, 0.4, 0.38], count = 1400, rate = 0.05, size = 1 }) {
  const n = count;
  const base = new Float32Array(n * 3), up = new Float32Array(n * 3), wind = new Float32Array(n * 3), seed = new Float32Array(n);
  const total = sources.reduce((s, x) => s + (x.w || 1), 0);
  const to = ((windFrom + 180) * Math.PI) / 180;
  const drift = height * THREE.MathUtils.clamp(windKmh / 12, 0.25, 4);
  let i = 0;
  const place = [];
  for (const s of sources) {
    const k = Math.max(1, Math.round((n * (s.w || 1)) / total));
    for (let j = 0; j < k && i < n; j++, i++) place.push([i, s]);
  }
  for (; i < n; i++) place.push([i, sources[i % sources.length]]);
  const pts = new THREE.Points(new THREE.BufferGeometry(), null);
  const reground = () => {
    for (const [k, s] of place) {
      const nrm = latLonToVec3(s.lat, s.lon, 1);
      const { east, north } = frameAt(nrm);
      const w = east.multiplyScalar(Math.sin(to)).add(north.multiplyScalar(Math.cos(to))).multiplyScalar(drift);
      latLonToVec3(s.lat, s.lon, 1 + groundAt(tiles, s.lat, s.lon)).toArray(base, k * 3);
      nrm.multiplyScalar(height).toArray(up, k * 3);
      w.toArray(wind, k * 3);
    }
    pts.geometry.attributes.position && (pts.geometry.attributes.position.needsUpdate = true);
  };
  for (let k = 0; k < n; k++) seed[k] = Math.random();
  reground();
  const geo = pts.geometry;
  geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  geo.setAttribute('aUp', new THREE.BufferAttribute(up, 3));
  geo.setAttribute('aWind', new THREE.BufferAttribute(wind, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  pts.material = new THREE.ShaderMaterial({
    uniforms: { uTime: fxClock, uScale: { value: 800 }, uSize: { value: height * 0.22 * size }, uColor: { value: new THREE.Vector3(...color) }, uRate: { value: rate } },
    vertexShader: /* glsl */`
      attribute vec3 aUp; attribute vec3 aWind; attribute float aSeed;
      uniform float uTime, uScale, uSize, uRate;
      varying float vA; varying float vAge;
      float h(float x) { return fract(sin(x * 91.17) * 43758.5); }
      void main() {
        float age = fract(uTime * uRate + aSeed);
        vec3 jit = (vec3(h(aSeed), h(aSeed + 1.3), h(aSeed + 2.7)) - 0.5) * uSize * (0.6 + age * 3.5);
        vec3 p = position + aUp * pow(age, 0.75) + aWind * pow(age, 1.35) + jit;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(uSize * (0.5 + age * 2.2) * uScale / -mv.z, 2.0, 90.0);
        vA = smoothstep(0.0, 0.08, age) * (1.0 - age);
        vAge = age;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying float vA; varying float vAge;
      void main() {
        float d = length(gl_PointCoord * 2.0 - 1.0);
        float a = smoothstep(1.0, 0.0, d);
        a *= a * vA * 0.28;
        if (a < 0.004) discard;
        vec3 c = mix(uColor * 0.7, uColor * 1.25, vAge); // abajo más oscuro, arriba se aclara
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, depthWrite: false,
  });
  pts.renderOrder = 10;
  pts.frustumCulled = false;
  pts.userData.reground = reground;
  pts.userData.setScale = (s) => { pts.material.uniforms.uScale.value = s; };
  return pts;
}

// ---------------------------------------------------------------------------------
// Espiral de nubes del ciclón (ilustrativa): disco tangente con brazos que giran
// ---------------------------------------------------------------------------------
export function spiralObject({ radius, south = false, tiles }) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { uTime: fxClock, uDir: { value: south ? -1 : 1 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uDir; varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.1; a *= 0.5; } return s; }
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          float r = length(q);
          if (r > 1.0) discard;
          float ang = atan(q.y, q.x) - uDir * uTime * 0.12;
          float arm = sin(ang * 2.0 * uDir + log(r + 0.02) * 5.5);
          vec2 sp = vec2(cos(ang), sin(ang)) * r;
          float n = fbm(sp * 5.0 + vec2(0.0, uTime * 0.05));
          float dens = smoothstep(-0.3, 0.9, arm + n * 1.1 - 0.25) * smoothstep(1.0, 0.45, r);
          dens *= smoothstep(0.035, 0.11, r); // ojo despejado
          dens += smoothstep(0.16, 0.09, r) * smoothstep(0.05, 0.1, r) * 0.6; // pared del ojo
          gl_FragColor = vec4(vec3(0.96, 0.97, 1.0) * (0.75 + 0.3 * n), clamp(dens * 0.55, 0.0, 0.62));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  mesh.renderOrder = 9;
  mesh.frustumCulled = false;
  let lat0 = 0, lon0 = 0;
  mesh.userData.place = (lat, lon) => {
    lat0 = lat; lon0 = lon;
    const n = latLonToVec3(lat, lon, 1);
    mesh.position.copy(n).multiplyScalar(1 + groundAt(tiles, lat, lon) + radius * 0.03);
    mesh.quaternion.setFromUnitVectors(UP, n);
  };
  mesh.userData.reground = () => mesh.userData.place(lat0, lon0);
  return mesh;
}

// ---------------------------------------------------------------------------------
// Ondas sísmicas (ilustrativas): frentes P (rápidos, azulados) y S (lentos, ámbar)
// ---------------------------------------------------------------------------------
export function wavesObject({ lat, lon, radius, tiles }) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { uTime: fxClock },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime; varying vec2 vUv;
        void main() {
          float d = length(vUv * 2.0 - 1.0);
          float ph = fract(uTime / 6.0);
          float rp = ph * 1.7, rs = ph * 1.0; // la S viaja a ~0,58 veces la velocidad de la P
          float p = exp(-pow((d - rp) * 110.0, 2.0)) * (1.0 - ph) * 0.55;
          float s = exp(-pow((d - rs) * 70.0, 2.0)) * (1.0 - ph) * 0.7;
          float edge = smoothstep(1.0, 0.85, d);
          vec3 c = vec3(0.45, 0.75, 1.0) * p + vec3(1.0, 0.62, 0.25) * s;
          gl_FragColor = vec4(c * edge, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }),
  );
  mesh.renderOrder = 7;
  mesh.frustumCulled = false;
  mesh.userData.reground = () => {
    const n = latLonToVec3(lat, lon, 1);
    mesh.position.copy(n).multiplyScalar(1 + groundAt(tiles, lat, lon) + radius * 0.002);
    mesh.quaternion.setFromUnitVectors(UP, n);
  };
  mesh.userData.reground();
  return mesh;
}

// ---------------------------------------------------------------------------------
// Réplicas: puntos luminosos por magnitud, color por profundidad, aparecen a su hora con un destello
// ---------------------------------------------------------------------------------
export function quakePointsObject(list, { tiles, t0 }) {
  const n = list.length;
  const pos = new Float32Array(n * 3), aT = new Float32Array(n), aM = new Float32Array(n), aD = new Float32Array(n);
  list.forEach((q, i) => { aT[i] = (q.t - t0) / 1000; aM[i] = q.mag; aD[i] = Math.min(1, q.depth / 300); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aM', new THREE.BufferAttribute(aM, 1));
  geo.setAttribute('aD', new THREE.BufferAttribute(aD, 1));
  const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uNow: { value: 0 }, uScale: { value: 800 } },
    vertexShader: /* glsl */`
      attribute float aT, aM, aD; uniform float uNow, uScale;
      varying vec3 vC; varying float vA;
      void main() {
        float age = uNow - aT;
        vA = age < 0.0 ? 0.0 : 1.0;
        float flash = age < 0.0 ? 0.0 : exp(-age / 1800.0) * 2.0; // destello la primera media hora
        vC = mix(mix(vec3(1.0, 0.92, 0.45), vec3(1.0, 0.45, 0.25), smoothstep(0.0, 0.25, aD)), vec3(0.6, 0.4, 1.0), smoothstep(0.25, 1.0, aD));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sz = 0.00012 * pow(1.55, aM) * (1.0 + flash);
        gl_PointSize = clamp(sz * uScale / -mv.z, 3.0, 70.0);
        vA *= 0.75 + flash * 0.3;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vA;
      void main() {
        if (vA <= 0.0) discard;
        float d = length(gl_PointCoord * 2.0 - 1.0);
        float ring = smoothstep(0.12, 0.0, abs(d - 0.75));
        float a = (exp(-d * d * 6.0) * 0.8 + ring * 0.7) * smoothstep(1.0, 0.85, d);
        gl_FragColor = vec4(mix(vC, vec3(1.0), exp(-d * d * 30.0) * 0.6) * a * vA, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  }));
  pts.renderOrder = 9;
  pts.frustumCulled = false;
  pts.userData.reground = () => {
    const v = new THREE.Vector3();
    list.forEach((q, i) => latLonToVec3(q.lat, q.lon, 1 + groundAt(tiles, q.lat, q.lon) + 0.000005, v).toArray(pos, i * 3));
    geo.attributes.position.needsUpdate = true;
  };
  pts.userData.reground();
  pts.userData.setTime = (t) => { pts.material.uniforms.uNow.value = (t - t0) / 1000; };
  pts.userData.setScale = (s) => { pts.material.uniforms.uScale.value = s; };
  return pts;
}
