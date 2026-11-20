// Efemérides precisas con astronomy-engine (MIT, se ejecuta en el navegador: sin
// peticiones ni límites). Sol, Luna y planetas en el sistema de la escena
// (fijo a la Tierra: X → Greenwich, Y → norte), y búsqueda de eclipses.
import * as THREE from 'three';

const LIB = 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.min.js';
export const AU_IN_EARTH_RADII = 149597870.7 / 6371;

let A = null;
let loading = null;

export function loadAstronomy() {
  if (A) return Promise.resolve(A);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIB;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => { A = window.Astronomy; A ? resolve(A) : reject(new Error('astronomy-engine')); };
    s.onerror = () => reject(new Error('astronomy-engine no disponible'));
    document.head.appendChild(s);
  });
  return loading;
}
export const ready = () => !!A;

/** Vector ecuatorial J2000 → sistema de la escena (rotación de la Tierra incluida). */
function toScene(vec, time, out = new THREE.Vector3()) {
  const v = A.RotateVector(A.Rotation_EQJ_EQD(time), vec);
  const th = (A.SiderealTime(time) * 15 * Math.PI) / 180;
  const x = v.x * Math.cos(th) + v.y * Math.sin(th);
  const y = -v.x * Math.sin(th) + v.y * Math.cos(th);
  return out.set(x, v.z, -y);
}

/** Dirección del Sol (unitaria) y posición de la Luna (radios terrestres). */
export function sunMoon(date, sunOut, moonOut) {
  const t = A.MakeTime(date);
  toScene(A.GeoVector(A.Body.Sun, t, true), t, sunOut).normalize();
  toScene(A.GeoMoon(t), t, moonOut).multiplyScalar(AU_IN_EARTH_RADII);
}

export const PLANETS = [
  { body: 'Mercury', name: 'Mercurio', color: '#c9b9a6' },
  { body: 'Venus', name: 'Venus', color: '#fff1c9' },
  { body: 'Mars', name: 'Marte', color: '#ff8a5c' },
  { body: 'Jupiter', name: 'Júpiter', color: '#ffe0b0' },
  { body: 'Saturn', name: 'Saturno', color: '#f3dc9c' },
  { body: 'Uranus', name: 'Urano', color: '#b8f0f0' },
  { body: 'Neptune', name: 'Neptuno', color: '#9fb8ff' },
];

/** Planetas: dirección vista desde la Tierra, brillo (magnitud) y distancia (millones de km). */
export function planets(date) {
  const t = A.MakeTime(date);
  return PLANETS.map((p) => {
    const vec = A.GeoVector(A.Body[p.body], t, true);
    const ill = A.Illumination(A.Body[p.body], t);
    return { ...p, dir: toScene(vec, t).normalize(), mag: ill.mag, distMkm: (Math.hypot(vec.x, vec.y, vec.z) * 149.5978707) };
  });
}

const KIND = { partial: 'parcial', annular: 'anular', total: 'total', penumbral: 'penumbral', hybrid: 'híbrido' };

/** Próximos eclipses (solares y lunares) a partir de una fecha. */
export function upcomingEclipses(from = new Date(), n = 2) {
  const out = [];
  let s = A.SearchGlobalSolarEclipse(A.MakeTime(from));
  for (let i = 0; i < n; i++) {
    out.push({ type: 'solar', kind: s.kind, kindEs: KIND[s.kind] || s.kind, peak: s.peak.date, lat: s.latitude, lon: s.longitude });
    s = A.NextGlobalSolarEclipse(s.peak);
  }
  let l = A.SearchLunarEclipse(A.MakeTime(from));
  for (let i = 0; i < n; i++) {
    out.push({ type: 'lunar', kind: l.kind, kindEs: KIND[l.kind] || l.kind, peak: l.peak.date });
    l = A.NextLunarEclipse(l.peak);
  }
  return out.sort((a, b) => a.peak - b.peak);
}

/**
 * Línea central de un eclipse solar: donde el eje de la sombra de la Luna toca la Tierra,
 * muestreada cada `stepMin` minutos alrededor del máximo.
 */
export function eclipsePath(peak, hours = 3, stepMin = 3) {
  const pts = [];
  const sun = new THREE.Vector3(), moon = new THREE.Vector3(), d = new THREE.Vector3();
  for (let m = -hours * 60; m <= hours * 60; m += stepMin) {
    sunMoon(new Date(peak.getTime() + m * 60000), sun, moon);
    // Recta: punto de la Luna + k · (−sol); intersección con la esfera unidad
    d.copy(sun).negate();
    const b = moon.dot(d), c = moon.lengthSq() - 1, disc = b * b - c;
    if (disc < 0) { if (pts.length) break; continue; }
    const k = -b - Math.sqrt(disc);
    pts.push(moon.clone().addScaledVector(d, k));
  }
  return pts;
}
