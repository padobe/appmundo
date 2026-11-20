// Imágenes de satélite de alta resolución y relieve 3D al acercarse.
// - Imágenes: Esri World Imagery (teselas Web Mercator, sin clave).
// - Relieve: AWS Terrain Tiles (formato Terrarium, datos abiertos, sin clave ni límite).
// Quadtree de teselas proyectadas sobre la esfera: cuanto más cerca está la cámara
// de una zona, más detalle se pide. Las teselas usan el mismo sombreado día/noche
// que el globo base, con sombreado de montañas según el sol y bruma con la distancia.
import * as THREE from 'three';
import { SHADE_PARS } from './globe.js';

const IMAGERY = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const LABELS = (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
const TERRAIN = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const MIN_Z = 5; // por debajo basta la textura base (4096 px ≈ nivel 4)
const MAX_Z = 18;
const ELEV_MIN_Z = 3; // el relieve de nivel bajo sirve de base mientras llega el detallado
const ELEV_MAX_Z = 13; // ~15 m/píxel: suficiente; más allá se reutiliza el padre
const TILE_PX = 256;
const MAX_CACHE = 320;
const MAX_ELEV_CACHE = 200;
const MAX_LEAVES = 190;
const MAX_INFLIGHT = 12;
const SKIP = 3; // niveles que se pueden saltar de golpe al acercarse (menos descargas intermedias)
const FADE_MS = 280;
const MORPH_MS = 450;
const MAX_ELEV_INFLIGHT = 6;
const D2R = Math.PI / 180;
const R_M = 6371000;
export const TERRAIN_EXAGGERATION = 1.6;

const vertex = /* glsl */ `
  attribute vec2 geoUv;
  attribute float aSkirt;
  uniform sampler2D elevMap;
  uniform vec4 uElevXf;     // escala.xy, desplazamiento.zw: uv de la tesela → uv de la tesela de relieve
  uniform sampler2D elevPrev;
  uniform vec4 uElevXfPrev;
  uniform float uMorph;     // 0 → relieve anterior, 1 → nuevo (transición suave, sin saltos)
  uniform float uExag;      // exageración vertical (0 = relieve apagado)
  uniform float uHasElev;
  uniform float uSkirt;
  varying vec2 vUv;
  varying vec2 vGeoUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vGeoUv = geoUv;
    float e = 0.0;
    if (uHasElev > 0.5) {
      float eNew = max(texture2D(elevMap, uElevXf.zw + uv * uElevXf.xy).r, 0.0);
      float eOld = max(texture2D(elevPrev, uElevXfPrev.zw + uv * uElevXfPrev.xy).r, 0.0);
      e = mix(eOld, eNew, uMorph);
    }
    vec3 p = position + normal * (e * uExag / ${R_M.toFixed(1)}) - normal * aSkirt * uSkirt;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D labelMap;
  uniform sampler2D elevMap;
  uniform vec4 uElevXf;
  uniform float uExag;
  uniform float uHasElev;
  uniform vec2 uTileSize;   // ancho y alto de la tesela en radianes (≈ radios terrestres)
  uniform float uLabels;
  uniform float uFlip;      // 1 si la imagen llegó como ImageBitmap (sin voltear)
  uniform float uAlpha;     // aparición gradual de la tesela
  uniform vec3 uFogColor;
  uniform float uFog;
  ${SHADE_PARS}
  varying vec2 vUv;
  varying vec2 vGeoUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  float elevAt(vec2 uv) { return max(texture2D(elevMap, uElevXf.zw + uv * uElevXf.xy).r, 0.0); }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 Nt = N;
    if (uHasElev > 0.5 && uExag > 0.0) {
      // Normal del relieve por diferencias centrales → las montañas proyectan luz y sombra
      float d = 1.0 / 128.0;
      float hx = (elevAt(vUv + vec2(d, 0.0)) - elevAt(vUv - vec2(d, 0.0))) * uExag / ${R_M.toFixed(1)};
      float hy = (elevAt(vUv + vec2(0.0, d)) - elevAt(vUv - vec2(0.0, d))) * uExag / ${R_M.toFixed(1)};
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), N));
      vec3 north = cross(N, east);
      Nt = normalize(N - east * hx / (2.0 * d * uTileSize.x) - north * hy / (2.0 * d * uTileSize.y));
    }
    // Las fotos de satélite ya traen la luz del día: se aclaran un poco para compensar el lambert
    vec2 iuv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlip));
    vec3 day = texture2D(dayMap, iuv).rgb * 1.12;
    vec3 col = shadeEarthT(day, vGeoUv, N, Nt, V);
    vec4 lab = texture2D(labelMap, iuv);
    col = mix(col, lab.rgb, lab.a * uLabels * 0.92);
    // Bruma atmosférica con la distancia (solo cerca del suelo)
    float distKm = length(cameraPosition - vPosW) * 6371.0;
    col = mix(col, uFogColor, (1.0 - exp(-distKm / 420.0)) * uFog);
    gl_FragColor = vec4(col, uAlpha);
    #include <colorspace_fragment>
  }
`;

/** Descarga una imagen como textura: abortable y decodificada fuera del hilo principal. */
async function loadTexture(url, signal) {
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      const t = new THREE.Texture(bmp);
      t.flipY = false; // ImageBitmap no se voltea al subirla: lo compensa el shader (uFlip)
      t.userData.flip = 1;
      t.needsUpdate = true;
      return t;
    } catch { /* se intenta con <img> */ }
  }
  const img = new Image();
  const u = URL.createObjectURL(blob);
  try {
    img.src = u;
    await img.decode();
  } finally { URL.revokeObjectURL(u); }
  const t = new THREE.Texture(img);
  t.userData.flip = 0;
  t.needsUpdate = true;
  return t;
}

const tile2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const lon2tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat, z) => {
  const r = lat * D2R;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

function toVec(lat, lon, out = new THREE.Vector3()) {
  const la = lat * D2R, phi = (lon + 180) * D2R;
  return out.set(-Math.cos(phi) * Math.cos(la), Math.sin(la), Math.sin(phi) * Math.cos(la));
}

const EMPTY = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
const FLAT = (() => {
  const t = new THREE.DataTexture(new Uint16Array([0]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
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
    this.cache = new Map(); // key -> tesela de imagen
    this.elev = new Map(); // key -> { state, tex, cpu, waiters }
    this.queue = [];
    this.inflight = 0;
    this.elevInflight = 0;
    this.labels = { value: 1 };
    this.exag = { value: TERRAIN_EXAGGERATION };
    this.fogColor = { value: new THREE.Color(0.6, 0.75, 0.95) };
    this.fog = { value: 0 };
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
    this.lastQuat = new THREE.Quaternion();
    this.errors = 0;
    this.active = false;
    this.animating = new Set();
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 256;
    this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  setLabels(on) { this.labels.value = on ? 1 : 0; }
  setTerrain(on) {
    this.exag.value = on ? TERRAIN_EXAGGERATION : 0;
    this.lastSelect = 0;
  }
  get terrainOn() { return this.exag.value > 0; }

  key(z, x, y) { return `${z}/${x}/${y}`; }

  /** Centro y radio angular de una tesela. */
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
    this.animate(now);
    const still = cam.position.distanceToSquared(this.lastCam) < 1e-14 && cam.quaternion.angleTo(this.lastQuat) < 1e-5;
    if (now - this.lastSelect < 120 && still) return;
    if (now - this.lastSelect < 60) return;
    this.lastSelect = now;
    this.lastCam.copy(cam.position);
    this.lastQuat.copy(cam.quaternion);

    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pxPerUnit = viewH / (2 * Math.tan((cam.fov * D2R) / 2));
    const camDir = cam.position.clone().normalize();
    const horizon = Math.acos(Math.min(1, 1 / cam.position.length())) + 0.004;
    const relief = this.terrainOn ? (9000 * this.exag.value) / R_M : 0;

    let leaves = [];
    let quality = 1.15;
    const sphere = new THREE.Sphere();
    const visit = (z, x, y) => {
      const b = this.bounds(z, x, y);
      if (camDir.angleTo(b.c) > horizon + b.ang) return; // tras el horizonte
      sphere.center.copy(b.c);
      const geoR = 2 * Math.sin(b.ang / 2) * 1.05;
      sphere.radius = geoR + 0.00002 + relief; // el margen de las montañas solo para saber si se ve
      if (!this.frustum.intersectsSphere(sphere)) return;
      const d = Math.max(cam.position.distanceTo(b.c) - geoR, h * 0.9, 1e-5);
      const widthRad = ((2 * Math.PI) / 2 ** z) * Math.cos(b.latC * D2R);
      const px = (widthRad * pxPerUnit) / d;
      const falloff = 1 + Math.max(0, d / Math.max(h, 1e-6) - 2) * 0.3;
      if (px > TILE_PX * quality * falloff && z < MAX_Z) {
        const n = z + 1;
        visit(n, 2 * x, 2 * y); visit(n, 2 * x + 1, 2 * y);
        visit(n, 2 * x, 2 * y + 1); visit(n, 2 * x + 1, 2 * y + 1);
      } else if (z >= MIN_Z) {
        leaves.push([z, x, y, d]);
      }
    };
    // Mirando al horizonte hay muchísimas teselas: se baja la calidad lejana hasta un máximo razonable
    for (;;) {
      leaves = [];
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) visit(2, x, y);
      if (leaves.length <= MAX_LEAVES || quality > 6) break;
      quality *= 1.35;
    }

    // Se dibuja la tesela si ya está, o su antepasado cargado más cercano.
    // Si falta mucho detalle, se pide un nivel intermedio (saltando hasta SKIP niveles)
    // para cubrir la vista con pocas descargas y luego afinar.
    const draw = new Set();
    const wanted = new Map();
    const relevant = new Set();
    const nearestReady = (z, x, y) => {
      for (let pz = z - 1, px = x >> 1, py = y >> 1; pz >= MIN_Z; pz--, px >>= 1, py >>= 1) {
        const p = this.cache.get(this.key(pz, px, py));
        if (p?.state === 'ready') return p;
      }
      return null;
    };
    for (const [z, x, y, d] of leaves) {
      for (let pz = z, px = x, py = y; pz >= MIN_Z; pz--, px >>= 1, py >>= 1) relevant.add(this.key(pz, px, py));
      const t = this.cache.get(this.key(z, x, y));
      if (t?.state === 'ready') {
        draw.add(t);
        t.leafAt = t.leafAt || now;
        // mientras aparece, se deja debajo la versión anterior
        if (now - t.readyAt < FADE_MS) { const a = nearestReady(z, x, y); if (a) draw.add(a); }
        continue;
      }
      const a = nearestReady(z, x, y);
      if (a) draw.add(a);
      const rz = Math.min(z, a ? a.z + SKIP : MIN_Z + 1);
      const rx = x >> (z - rz), ry = y >> (z - rz);
      const key = this.key(rz, rx, ry);
      if (!this.cache.has(key) && !wanted.has(key)) wanted.set(key, { z: rz, x: rx, y: ry, d });
    }
    for (const t of [...this.cache.values()]) {
      const on = draw.has(t);
      if (t.mesh) t.mesh.visible = on;
      if (on) {
        t.used = now;
        if (this.terrainOn) this.attachElevation(t);
        // Nombres: solo para teselas definitivas que llevan un momento a la vista
        if (this.labels.value && t.z <= 15 && !t.labelsRequested && t.leafAt && now - t.leafAt > 400) this.loadLabels(t);
      } else {
        t.leafAt = 0;
      }
      // Descargas que ya no sirven (la vista cambió): se cancelan
      if (t.state === 'loading' && !relevant.has(t.key)) {
        t.ctrl?.abort();
        this.cache.delete(t.key);
      }
    }

    this.queue = [...wanted.values()].sort((a, b) => a.z - b.z || a.d - b.d);
    this.pump();
    this.evict();
  }

  /** Animaciones por fotograma: aparición de teselas y transición del relieve. */
  animate(now) {
    for (const t of this.animating) {
      if (!t.mesh) { this.animating.delete(t); continue; }
      const u = t.mesh.material.uniforms;
      const a = Math.min(1, (now - t.readyAt) / FADE_MS);
      const m = t.morphStart != null ? Math.min(1, (now - t.morphStart) / MORPH_MS) : 1;
      u.uAlpha.value = a * a * (3 - 2 * a);
      t.mesh.material.transparent = a < 1;
      u.uMorph.value = m * m * (3 - 2 * m);
      if (a >= 1 && m >= 1) this.animating.delete(t);
    }
  }

  // --- Imágenes -------------------------------------------------------------
  pump() {
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const { z, x, y } = this.queue.shift();
      const key = this.key(z, x, y);
      if (this.cache.has(key)) continue;
      const tile = { key, z, x, y, state: 'loading', used: performance.now(), mesh: null, ctrl: new AbortController() };
      this.cache.set(key, tile);
      this.inflight++;
      loadTexture(IMAGERY(z, x, y), tile.ctrl.signal).then((tex) => {
        this.inflight--;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.aniso;
        if (this.cache.get(key) !== tile) { tex.dispose(); tex.image?.close?.(); this.pump(); return; }
        this.build(tile, tex);
        this.lastSelect = 0;
        this.pump();
      }, (e) => {
        this.inflight--;
        if (e?.name === 'AbortError') { this.pump(); return; }
        tile.state = 'error';
        if (++this.errors === 6) this.onError?.();
        this.pump();
      });
    }
  }

  build(tile, tex) {
    const { z, x, y } = tile;
    const b = this.bounds(z, x, y);
    const N = z >= 9 ? 32 : z >= 7 ? 24 : 16;
    const pos = [], nrm = [], uv = [], geo = [], skirt = [], idx = [];
    const center = b.c.clone();
    const v = new THREE.Vector3();
    const push = (i, j, isSkirt) => {
      const lat = tile2lat(y + j / N, z); // filas equiespaciadas en Mercator
      const lon = b.lon0 + (b.lon1 - b.lon0) * (i / N);
      toVec(lat, lon, v);
      nrm.push(v.x, v.y, v.z);
      pos.push(v.x - center.x, v.y - center.y, v.z - center.z); // relativo al centro: más precisión
      uv.push(i / N, 1 - j / N);
      geo.push((lon + 180) / 360, (lat + 90) / 180);
      skirt.push(isSkirt ? 1 : 0);
      return pos.length / 3 - 1;
    };
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) push(i, j, false);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, c = a + N + 1;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    // Faldones en los bordes: tapan las grietas entre teselas de distinto nivel de relieve
    const edges = [
      Array.from({ length: N + 1 }, (_, i) => [i, 0]),
      Array.from({ length: N + 1 }, (_, i) => [N - i, N]),
      Array.from({ length: N + 1 }, (_, j) => [0, N - j]),
      Array.from({ length: N + 1 }, (_, j) => [N, j]),
    ];
    for (const edge of edges) {
      let prevTop = null, prevBottom = null;
      for (const [i, j] of edge) {
        const top = j * (N + 1) + i;
        const bottom = push(i, j, true);
        if (prevTop != null) idx.push(prevTop, top, prevBottom, top, bottom, prevBottom);
        prevTop = top; prevBottom = bottom;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('geoUv', new THREE.Float32BufferAttribute(geo, 2));
    g.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
    g.setIndex(idx);

    const tileRad = (2 * Math.PI) / 2 ** z;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: tex },
        labelMap: { value: EMPTY },
        elevMap: { value: FLAT },
        uElevXf: { value: new THREE.Vector4(1, 1, 0, 0) },
        elevPrev: { value: FLAT },
        uElevXfPrev: { value: new THREE.Vector4(1, 1, 0, 0) },
        uMorph: { value: 1 },
        uFlip: { value: tex.userData.flip ?? 0 },
        uAlpha: { value: 0 },
        uHasElev: { value: 0 },
        uTileSize: { value: new THREE.Vector2(tileRad * Math.cos(b.latC * D2R), ((b.lat0 - b.lat1) * D2R)) },
        uSkirt: { value: tileRad * 0.04 + 0.0004 },
        uExag: this.exag,
        uLabels: this.labels,
        uFogColor: this.fogColor,
        uFog: this.fog,
        nightMap: this.shared.nightMap,
        waterMap: this.shared.waterMap,
        sunDir: this.shared.sunDir,
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      side: THREE.DoubleSide,
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
    tile.readyAt = performance.now();
    this.animating.add(tile);
    this.group.add(mesh);

  }

  loadLabels(tile) {
    tile.labelsRequested = true;
    const { z, x, y } = tile;
    loadTexture(LABELS(z, x, y)).then((lt) => {
      lt.colorSpace = THREE.SRGBColorSpace;
      const u = tile.mesh?.material.uniforms;
      // misma orientación que la imagen (ambas llegan por el mismo camino)
      if (u && (lt.userData.flip ?? 0) === u.uFlip.value) u.labelMap.value = lt;
      else { lt.dispose(); lt.image?.close?.(); }
    }, () => {});
  }

  // --- Relieve --------------------------------------------------------------
  elevKeyFor(z, x, y) {
    const zE = Math.min(z, ELEV_MAX_Z);
    const dz = z - zE;
    return { zE, xE: x >> dz, yE: y >> dz, dz };
  }

  /** Asigna a la tesela el mejor relieve disponible: el suyo, o el de un antepasado mientras llega. */
  attachElevation(tile) {
    if (tile.elevAttached || !tile.mesh) return;
    const ideal = Math.min(tile.z, ELEV_MAX_Z);
    const want = this.requestElev(ideal, tile.x >> (tile.z - ideal), tile.y >> (tile.z - ideal));
    if (want.state === 'queued' || want.state === 'loading') want.waiters.add(tile);
    for (let zE = ideal; zE >= ELEV_MIN_Z; zE--) {
      const dz = tile.z - zE;
      const xE = tile.x >> dz, yE = tile.y >> dz;
      const e = zE === ideal ? want : this.elev.get(this.key(zE, xE, yE));
      if (e?.state !== 'ready') continue;
      if (tile.elevZ === zE) return;
      const u = tile.mesh.material.uniforms;
      const s = 1 / 2 ** dz;
      // el relieve nuevo crece desde el anterior en vez de saltar
      u.elevPrev.value = u.uHasElev.value ? u.elevMap.value : FLAT;
      u.uElevXfPrev.value.copy(u.uElevXf.value);
      u.uMorph.value = 0;
      tile.morphStart = performance.now();
      this.animating.add(tile);
      u.elevMap.value = e.tex;
      u.uElevXf.value.set(s, s, (tile.x - (xE << dz)) * s, (2 ** dz - 1 - (tile.y - (yE << dz))) * s);
      u.uHasElev.value = 1;
      tile.elevZ = zE;
      tile.elevAttached = zE === ideal;
      e.used = performance.now();
      return;
    }
    // Nada cargado aún: se pide también el nivel base para tener algo pronto
    this.requestElev(ELEV_MIN_Z + 2, tile.x >> (tile.z - ELEV_MIN_Z - 2), tile.y >> (tile.z - ELEV_MIN_Z - 2));
  }

  requestElev(z, x, y) {
    const key = this.key(z, x, y);
    let e = this.elev.get(key);
    if (e) return e;
    e = { key, z, x, y, state: 'queued', tex: null, cpu: null, waiters: new Set(), used: performance.now() };
    this.elev.set(key, e);
    this.pumpElev();
    return e;
  }

  pumpElev() {
    const queued = [...this.elev.values()].filter((e) => e.state === 'queued').sort((a, b) => a.z - b.z);
    for (const e of queued) {
      if (this.elevInflight >= MAX_ELEV_INFLIGHT) break;
      e.state = 'loading';
      this.elevInflight++;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.elevInflight--;
        this.decodeElev(e, img);
        for (const t of e.waiters) { t.elevAttached = false; this.attachElevation(t); }
        this.lastSelect = 0;
        e.waiters.clear();
        this.pumpElev();
      };
      img.onerror = () => { this.elevInflight--; e.state = 'error'; this.pumpElev(); };
      img.src = TERRAIN(e.z, e.x, e.y);
    }
  }

  decodeElev(e, img) {
    const g = this.ctx2d;
    g.clearRect(0, 0, 256, 256);
    g.drawImage(img, 0, 0, 256, 256);
    const d = g.getImageData(0, 0, 256, 256).data;
    const half = new Uint16Array(256 * 256);
    const cpu = new Float32Array(64 * 64);
    for (let r = 0; r < 256; r++) {
      const dst = (255 - r) * 256; // fila 0 = sur, para que v=1 sea el norte como en la tesela
      for (let c = 0; c < 256; c++) {
        const i = (r * 256 + c) * 4;
        const m = d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
        half[dst + c] = THREE.DataUtils.toHalfFloat(m);
        if ((r & 3) === 0 && (c & 3) === 0) cpu[(r >> 2) * 64 + (c >> 2)] = m;
      }
    }
    const tex = new THREE.DataTexture(half, 256, 256, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    e.tex = tex;
    e.cpu = cpu; // 64×64, fila 0 = norte
    e.state = 'ready';
  }

  /** Altura del terreno (m, sin exagerar) en un punto, con el relieve ya cargado; 0 si no hay datos. */
  heightAt(lat, lon) {
    if (!this.terrainOn || Math.abs(lat) > 85) return 0;
    for (let z = ELEV_MAX_Z; z >= ELEV_MIN_Z; z--) {
      const fx = lon2tileX(lon, z), fy = lat2tileY(lat, z);
      const e = this.elev.get(this.key(z, Math.floor(fx), Math.floor(fy)));
      if (e?.state !== 'ready') continue;
      const c = Math.min(63, Math.max(0, Math.floor((fx % 1) * 64)));
      const r = Math.min(63, Math.max(0, Math.floor((fy % 1) * 64)));
      return Math.max(0, e.cpu[r * 64 + c]);
    }
    return 0;
  }

  evict() {
    if (this.cache.size > MAX_CACHE) {
      const old = [...this.cache.values()]
        .filter((t) => t.state !== 'loading' && !t.mesh?.visible)
        .sort((a, b) => a.used - b.used);
      for (const t of old.slice(0, this.cache.size - MAX_CACHE)) {
        if (t.mesh) {
          this.group.remove(t.mesh);
          t.mesh.geometry.dispose();
          const u = t.mesh.material.uniforms;
          u.dayMap.value.dispose();
          u.dayMap.value.image?.close?.();
          if (u.labelMap.value !== EMPTY) { u.labelMap.value.dispose(); u.labelMap.value.image?.close?.(); }
          t.mesh.material.dispose();
          t.mesh = null;
        }
        this.cache.delete(t.key);
      }
    }
    if (this.elev.size > MAX_ELEV_CACHE) {
      const inUse = new Set();
      for (const t of this.cache.values()) if (t.mesh?.visible) inUse.add(t.mesh.material.uniforms.elevMap.value);
      const old = [...this.elev.values()]
        .filter((e) => e.state === 'ready' && !inUse.has(e.tex))
        .sort((a, b) => a.used - b.used);
      for (const e of old.slice(0, this.elev.size - MAX_ELEV_CACHE)) {
        // las teselas que lo usaban vuelven a pedirlo cuando se muestren
        for (const t of this.cache.values()) {
          if (t.mesh && t.mesh.material.uniforms.elevMap.value === e.tex) {
            t.mesh.material.uniforms.elevMap.value = FLAT;
            t.mesh.material.uniforms.uHasElev.value = 0;
            t.elevAttached = false;
            t.elevZ = null;
          }
        }
        e.tex.dispose();
        this.elev.delete(e.key);
      }
    }
  }
}
