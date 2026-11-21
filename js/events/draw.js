// Dibujo de polígonos y líneas GeoJSON sobre el globo (radio 1).
import * as THREE from 'three';
import { latLonToVec3 } from '../geo.js';
import { thickLine } from './fx.js';

const LINE_R = 1.0016; // ~10 km: zonas grandes (en las pequeñas se pinta sobre el relieve)
const FILL_R = 1.0014;

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
    if (!r.length) continue;
    for (const [lon0, lat] of unwrap(r)) {
      any = true;
      w = Math.min(w, lon0); e = Math.max(e, lon0); s = Math.min(s, lat); n = Math.max(n, lat);
    }
  }
  return any ? { w, e, s, n } : null;
}

export function lineObject(ring, { color, opacity = 0.9, dashed = false, closed = true, width = 2.5 }) {
  const pts = unwrap(ring).map(([lon, lat]) => latLonToVec3(lat, lon, LINE_R));
  return thickLine(pts, { color, opacity, dashed, closed, width });
}

/** Suaviza contornos escalonados (polígonos derivados de píxeles) con dos pasadas de Chaikin. */
export function smoothRing(ring, passes = 2) {
  let r = unwrap(ring);
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  if (r.length < 4 || r.length > 4000) return r;
  for (let k = 0; k < passes; k++) {
    const o = [];
    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
      o.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    r = o;
  }
  return r;
}
const smoothPolys = (polys) => polys.map((p) => ({ ...p, outer: smoothRing(p.outer), holes: p.holes.map((h) => smoothRing(h)) }));

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

export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

// ---------------------------------------------------------------------------------
// Capas de área: objeto 3D (líneas + relleno) para zonas grandes y "calcomanía" pintada
// en las teselas para zonas pequeñas (sigue el relieve). En ambos casos la vista añade
// una cortina de luz 3D sobre el contorno (layer.wall).
// ---------------------------------------------------------------------------------
export function areaLayer(id, label, polys, style, gate = () => true) {
  const { color, fill = 0.2, line = 0.95, dashed = false, frame = true, wall = !dashed } = style;
  polys = smoothPolys(polys);
  const g = new THREE.Group();
  for (const p of polys) {
    g.add(lineObject(p.outer, { color, opacity: line, dashed, width: dashed ? 1.6 : 2.6 }));
    if (fill > 0) { const f = fillObject(p, { color, opacity: fill * 0.7 }); if (f) g.add(f); }
  }
  const layer = {
    id, label, object: g, visible: true, wall, color, polys,
    decal: { polys, color, fill, line, dashed, frame },
    update(t) {
      layer.visible = gate(t);
      g.visible = layer.visible;
      if (layer.wallObj) layer.wallObj.visible = layer.visible;
    },
  };
  return layer;
}

/** Caja que envuelve las capas con calcomanía (con margen); null si cruza el antimeridiano. */
export function decalBox(layers) {
  const rings = layers.filter((l) => l.decal.frame).flatMap((l) => l.decal.polys.map((p) => p.outer));
  const b = bboxOf(rings);
  if (!b) return null;
  const padX = Math.max((b.e - b.w) * 0.2, 0.02), padY = Math.max((b.n - b.s) * 0.2, 0.02);
  const box = { w: b.w - padX, e: b.e + padX, s: Math.max(-89, b.s - padY), n: Math.min(89, b.n + padY) };
  return box.w < -180 || box.e > 180 ? null : box;
}

/** Pinta las capas visibles en el lienzo (proyección lineal lon/lat sobre `box`): relleno suave,
 *  halo difuminado y trazo con núcleo claro, para que se lea como luz sobre el terreno. */
export function paintDecal(canvas, box, layers, t = Date.now(), res = 2048) {
  const lonSpan = box.e - box.w, latSpan = box.n - box.s;
  const k = res / Math.max(lonSpan, latSpan);
  const W = Math.max(64, Math.ceil(lonSpan * k)), H = Math.max(64, Math.ceil(latSpan * k));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  const cx = (box.w + box.e) / 2;
  const lw = Math.max(3, W / 480);
  const toX = (lon) => (lon + 360 * Math.round((cx - lon) / 360) - box.w) * k;
  const toY = (lat) => (box.n - lat) * k;
  for (const l of layers) {
    if (l.decal.custom) { l.decal.custom(g, { toX, toY, k }, t); continue; }
    const { polys, color, fill, line, dashed } = l.decal;
    g.beginPath();
    for (const p of polys) {
      for (const ring of [p.outer, ...p.holes]) {
        ring.forEach(([lon, lat], i) => { if (i) g.lineTo(toX(lon), toY(lat)); else g.moveTo(toX(lon), toY(lat)); });
        g.closePath();
      }
    }
    g.lineJoin = 'round';
    g.setLineDash(dashed ? [lw * 3, lw * 2] : []);
    if (fill > 0) { g.globalAlpha = fill * 0.75; g.fillStyle = color; g.fill('evenodd'); }
    if (!dashed) {
      g.save();
      g.globalAlpha = line * 0.55; g.strokeStyle = color; g.lineWidth = lw * 4;
      g.filter = `blur(${Math.round(lw * 2)}px)`;
      g.stroke();
      g.restore();
    }
    g.globalAlpha = line; g.strokeStyle = color; g.lineWidth = lw;
    g.stroke();
    if (!dashed) { g.globalAlpha = line * 0.7; g.strokeStyle = '#fff6e8'; g.lineWidth = lw * 0.35; g.stroke(); }
  }
  g.globalAlpha = 1;
  g.filter = 'none';
}
