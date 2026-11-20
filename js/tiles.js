// Imágenes de satélite de alta resolución al acercarse (Esri World Imagery).
// Quadtree de teselas Web Mercator proyectadas sobre la esfera: cuanto más cerca
// está la cámara de una zona, más nivel de detalle se pide para ella.
// Las teselas usan el mismo sombreado día/noche que el globo base.
import * as THREE from 'three';
import { SHADE_PARS } from './globe.js';

const IMAGERY = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const LABELS = (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;

const MIN_Z = 5; // por debajo basta la textura base (4096 px ≈ nivel 4)
const MAX_Z = 18;
const TILE_PX = 256;
const MAX_CACHE = 320;
const MAX_INFLIGHT = 8;
const D2R = Math.PI / 180;

const vertex = /* glsl */ `
  attribute vec2 geoUv;
  varying vec2 vUv;
  varying vec2 vGeoUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vGeoUv = geoUv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D labelMap;
  uniform float uLabels;
  ${SHADE_PARS}
  varying vec2 vUv;
  varying vec2 vGeoUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    // Las fotos de satélite ya traen la luz del día: se aclaran un poco para compensar el lambert
    vec3 day = texture2D(dayMap, vUv).rgb * 1.12;
    vec3 col = shadeEarth(day, vGeoUv, N, V);
    vec4 lab = texture2D(labelMap, vUv);
    col = mix(col, lab.rgb, lab.a * uLabels * 0.92);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const tile2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;

function toVec(lat, lon, out = new THREE.Vector3()) {
  const la = lat * D2R, phi = (lon + 180) * D2R;
  return out.set(-Math.cos(phi) * Math.cos(la), Math.sin(la), Math.sin(phi) * Math.cos(la));
}

const EMPTY = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

export class SatelliteTiles {
  constructor({ scene, camera, renderer, earthUniforms, onError }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.shared = earthUniforms;
    this.onError = onError;
    this.cache = new Map(); // key -> tile
    this.queue = [];
    this.inflight = 0;
    this.labels = { value: 1 };
    this.enabled = true;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.frustum = new THREE.Frustum();
    this.projView = new THREE.Matrix4();
    this.lastSelect = 0;
    this.lastCam = new THREE.Vector3();
    this.errors = 0;
    this.active = false;
  }

  setLabels(on) { this.labels.value = on ? 1 : 0; }

  key(z, x, y) { return `${z}/${x}/${y}`; }

  /** Centro y radio angular de una tesela (memorizado). */
  bounds(z, x, y) {
    const lat0 = tile2lat(y, z), lat1 = tile2lat(y + 1, z);
    const lon0 = tile2lon(x, z), lon1 = tile2lon(x + 1, z);
    const c = toVec((lat0 + lat1) / 2, (lon0 + lon1) / 2);
    let maxAng = 0;
    const t = new THREE.Vector3();
    for (const [la, lo] of [[lat0, lon0], [lat0, lon1], [lat1, lon0], [lat1, lon1]]) {
      maxAng = Math.max(maxAng, c.angleTo(toVec(la, lo, t)));
    }
    return { c, ang: maxAng, latC: (lat0 + lat1) / 2, lat0, lat1, lon0, lon1 };
  }

  update(viewH) {
    const cam = this.camera;
    const h = cam.position.length() - 1;
    const show = this.enabled && h < 1.0;
    this.group.visible = show;
    this.active = show;
    if (!show) return;

    const now = performance.now();
    if (now - this.lastSelect < 120 && cam.position.distanceToSquared(this.lastCam) < 1e-12) return;
    this.lastSelect = now;
    this.lastCam.copy(cam.position);

    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pxPerUnit = viewH / (2 * Math.tan((cam.fov * D2R) / 2));
    const camDir = cam.position.clone().normalize();
    const horizon = Math.acos(Math.min(1, 1 / cam.position.length()));

    const leaves = [];
    const sphere = new THREE.Sphere();
    const visit = (z, x, y) => {
      const b = this.bounds(z, x, y);
      // Fuera del horizonte o del encuadre → nada
      if (camDir.angleTo(b.c) > horizon + b.ang) return;
      sphere.center.copy(b.c);
      sphere.radius = 2 * Math.sin(b.ang / 2) * 1.05 + 0.00002;
      if (!this.frustum.intersectsSphere(sphere)) return;
      // Tamaño en pantalla de la tesela vista desde la cámara
      const d = Math.max(cam.position.distanceTo(b.c) - sphere.radius, h * 0.9, 1e-5);
      const widthRad = ((2 * Math.PI) / 2 ** z) * Math.cos(b.latC * D2R);
      const px = (widthRad * pxPerUnit) / d;
      if (px > TILE_PX * 1.15 && z < MAX_Z) {
        const n = z + 1;
        visit(n, 2 * x, 2 * y); visit(n, 2 * x + 1, 2 * y);
        visit(n, 2 * x, 2 * y + 1); visit(n, 2 * x + 1, 2 * y + 1);
      } else if (z >= MIN_Z) {
        leaves.push([z, x, y, d]);
      }
    };
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) visit(2, x, y);

    // Qué se dibuja: la tesela si ya está, o su antepasado cargado más cercano
    const draw = new Set();
    const wanted = [];
    for (const [z, x, y, d] of leaves) {
      const t = this.cache.get(this.key(z, x, y));
      if (t?.state === 'ready') { draw.add(t); continue; }
      if (!t) wanted.push({ z, x, y, d });
      for (let pz = z - 1, px = x >> 1, py = y >> 1; pz >= MIN_Z; pz--, px >>= 1, py >>= 1) {
        const p = this.cache.get(this.key(pz, px, py));
        if (p?.state === 'ready') { draw.add(p); break; }
      }
    }
    for (const t of this.cache.values()) {
      const on = draw.has(t);
      if (t.mesh) t.mesh.visible = on;
      if (on) t.used = now;
    }

    // Cola: primero los niveles gruesos (rellenan rápido) y los más cercanos
    wanted.sort((a, b) => a.z - b.z || a.d - b.d);
    this.queue = wanted;
    this.pump();
    this.evict();
  }

  pump() {
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const { z, x, y } = this.queue.shift();
      const key = this.key(z, x, y);
      if (this.cache.has(key)) continue;
      const tile = { key, z, x, y, state: 'loading', used: performance.now(), mesh: null };
      this.cache.set(key, tile);
      this.inflight++;
      this.loader.load(
        IMAGERY(z, x, y),
        (tex) => {
          this.inflight--;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.aniso;
          if (!this.cache.has(key)) { tex.dispose(); return; }
          this.build(tile, tex);
          this.lastSelect = 0; // reevaluar en el siguiente frame
          this.pump();
        },
        undefined,
        () => {
          this.inflight--;
          tile.state = 'error';
          if (++this.errors === 6) this.onError?.();
          this.pump();
        },
      );
    }
  }

  build(tile, tex) {
    const { z, x, y } = tile;
    const b = this.bounds(z, x, y);
    const N = z <= 6 ? 16 : z <= 9 ? 10 : 6;
    const pos = [], nrm = [], uv = [], geo = [], idx = [];
    const center = b.c.clone();
    const v = new THREE.Vector3();
    for (let j = 0; j <= N; j++) {
      // filas equiespaciadas en Mercator → la textura encaja sin deformarse
      const lat = tile2lat(y + j / N, z);
      for (let i = 0; i <= N; i++) {
        const lon = b.lon0 + (b.lon1 - b.lon0) * (i / N);
        toVec(lat, lon, v);
        nrm.push(v.x, v.y, v.z);
        pos.push(v.x - center.x, v.y - center.y, v.z - center.z); // relativo al centro: más precisión
        uv.push(i / N, 1 - j / N);
        geo.push((lon + 180) / 360, (lat + 90) / 180);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, c = a + N + 1;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('geoUv', new THREE.Float32BufferAttribute(geo, 2));
    g.setIndex(idx);

    const labelTex = { value: EMPTY };
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: tex },
        labelMap: labelTex,
        uLabels: this.labels,
        nightMap: this.shared.nightMap,
        waterMap: this.shared.waterMap,
        sunDir: this.shared.sunDir,
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2 * z,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.copy(center);
    mesh.renderOrder = 1 + z / 100;
    mesh.frustumCulled = false;
    mesh.visible = false;
    tile.mesh = mesh;
    tile.state = 'ready';
    this.group.add(mesh);

    // Etiquetas (fronteras y nombres): opcionales, si fallan no pasa nada
    if (z >= 5) {
      this.loader.load(LABELS(z, x, y), (lt) => {
        lt.colorSpace = THREE.SRGBColorSpace;
        if (tile.mesh) labelTex.value = lt; else lt.dispose();
      }, undefined, () => {});
    }
  }

  evict() {
    if (this.cache.size <= MAX_CACHE) return;
    const old = [...this.cache.values()]
      .filter((t) => t.state !== 'loading' && !t.mesh?.visible)
      .sort((a, b) => a.used - b.used);
    for (const t of old.slice(0, this.cache.size - MAX_CACHE)) {
      if (t.mesh) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        const u = t.mesh.material.uniforms;
        u.dayMap.value.dispose();
        if (u.labelMap.value !== EMPTY) u.labelMap.value.dispose();
        t.mesh.material.dispose();
        t.mesh = null;
      }
      this.cache.delete(t.key);
    }
  }
}
