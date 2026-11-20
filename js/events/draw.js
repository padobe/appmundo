// Dibujo de polígonos y líneas GeoJSON sobre el globo (radio 1).
import * as THREE from 'three';
import { latLonToVec3 } from '../geo.js';

const LINE_R = 1.0045;
const FILL_R = 1.0042;

/** Desenrolla las longitudes para que un anillo no salte al cruzar el antimeridiano. */
function unwrap(ring, ref) {
  let prev = ref ?? ring[0][0];
  return ring.map(([lon, lat]) => {
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    return [lon, lat];
  });
}

/** Polígonos de un Polygon/MultiPolygon como { outer, holes }. */
export function polygonsOf(geom) {
  if (geom?.type === 'Polygon') return [{ outer: geom.coordinates[0], holes: geom.coordinates.slice(1) }];
  if (geom?.type === 'MultiPolygon') return geom.coordinates.map((p) => ({ outer: p[0], holes: p.slice(1) }));
  return [];
}

export function bboxOf(rings) {
  let w = 180, e = -180, s = 90, n = -90, any = false;
  for (const r of rings) {
    for (const [lon0, lat] of unwrap(r)) {
      any = true;
      w = Math.min(w, lon0); e = Math.max(e, lon0); s = Math.min(s, lat); n = Math.max(n, lat);
    }
  }
  return any ? { w, e, s, n } : null;
}

export function lineObject(ring, { color, opacity = 0.9, dashed = false, closed = true }) {
  const pts = unwrap(ring).map(([lon, lat]) => latLonToVec3(lat, lon, LINE_R));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, depthWrite: false, dashSize: 0.006, gapSize: 0.005 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = closed ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 4;
  line.frustumCulled = false;
  return line;
}

/** Relleno translúcido. Solo para polígonos pequeños: en la esfera las cuerdas largas se hundirían. */
export function fillObject({ outer, holes }, { color, opacity = 0.16, maxSpan = 8 }) {
  const o = unwrap(outer);
  const lons = o.map((p) => p[0]), lats = o.map((p) => p[1]);
  if (Math.max(...lons) - Math.min(...lons) > maxSpan || Math.max(...lats) - Math.min(...lats) > maxSpan) return null;
  const contour = o.map(([x, y]) => new THREE.Vector2(x, y));
  const hs = holes.map((h) => unwrap(h, o[0][0]).map(([x, y]) => new THREE.Vector2(x, y)));
  let faces;
  try { faces = THREE.ShapeUtils.triangulateShape(contour, hs); } catch { return null; }
  if (!faces.length) return null;
  const all = [...contour, ...hs.flat()];
  const pos = new Float32Array(all.length * 3);
  all.forEach((v, i) => latLonToVec3(v.y, v.x, FILL_R).toArray(pos, i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(faces.flat());
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}

export function pointObject(lat, lon, { color = '#ffffff', size = 9 } = {}) {
  const geo = new THREE.BufferGeometry().setFromPoints([latLonToVec3(lat, lon, 1.005)]);
  const p = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthWrite: false, transparent: true }));
  p.renderOrder = 7;
  p.frustumCulled = false;
  return p;
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}
