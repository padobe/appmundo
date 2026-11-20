// Utilidades geográficas compartidas por todas las capas.
// Convención: globo de radio 1 centrado en el origen, fijo en el mundo
// (la cámara es la que orbita). Coincide con el mapeo UV de THREE.SphereGeometry
// para texturas equirectangulares.
import * as THREE from 'three';

export const EARTH_RADIUS_KM = 6371;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function latLonToVec3(lat, lon, r = 1, out = new THREE.Vector3()) {
  const la = lat * D2R;
  const phi = (lon + 180) * D2R;
  return out.set(
    -Math.cos(phi) * Math.cos(la) * r,
    Math.sin(la) * r,
    Math.sin(phi) * Math.cos(la) * r,
  );
}

export function vec3ToLatLon(v) {
  const len = v.length() || 1;
  const lat = Math.asin(THREE.MathUtils.clamp(v.y / len, -1, 1)) * R2D;
  let lon = Math.atan2(v.z, -v.x) * R2D - 180;
  if (lon < -180) lon += 360;
  return { lat, lon };
}

/** Interpola (o extrapola si f > 1) sobre el círculo máximo entre dos vectores unitarios. */
const _axis = new THREE.Vector3();
export function greatCircle(a, b, f, out = new THREE.Vector3()) {
  const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
  if (angle < 1e-7) return out.copy(a);
  _axis.crossVectors(a, b).normalize();
  return out.copy(a).applyAxisAngle(_axis, angle * f);
}

/** ¿Tapa la esfera terrestre el punto `p` visto desde la cámara? */
export function isOccluded(p, camPos, radius = 1) {
  const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
  const L = Math.hypot(dx, dy, dz);
  const ux = dx / L, uy = dy / L, uz = dz / L;
  const b = camPos.x * ux + camPos.y * uy + camPos.z * uz;
  const c = camPos.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < L - 1e-4;
}

const _p = new THREE.Vector3();
/** Proyecta un punto del mundo a píxeles de pantalla (CSS). */
export function toScreen(p, camera, w, h) {
  _p.copy(p).project(camera);
  return { x: (_p.x + 1) * 0.5 * w, y: (1 - _p.y) * 0.5 * h, behind: _p.z > 1 };
}

export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const eo = lon >= 0 ? 'E' : 'O';
  return `${Math.abs(lat).toFixed(1)}° ${ns} · ${Math.abs(lon).toFixed(1)}° ${eo}`;
}
