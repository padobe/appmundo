// Planeta en vivo — punto de entrada.
// Escena, cámara, controles y bucle. Los datos en vivo viven en "capas"
// (js/layers/*): cada una implementa start(), update(dt), pick(x, y, r) y setVisible(on).
// Para añadir otra fuente basta con crear otra capa y registrarla abajo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createEarth } from './globe.js';
import { SatelliteTiles } from './tiles.js';
import { subsolarPoint } from './sun.js';
import { latLonToVec3 } from './geo.js';
import { Timeline } from './timeline.js';
import { ui } from './ui.js';
import { EarthquakesLayer } from './layers/earthquakes.js';
import { IssLayer } from './layers/iss.js';
import { CloudsLayer } from './layers/clouds.js';

const IS_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_H = 0.00025; // ≈ 1,6 km sobre el suelo
const MAX_H = 9;

const time = new Timeline();
ui.startClock(time);
if (innerWidth < 1100 || innerHeight < 760) document.querySelector('.layers')?.removeAttribute('open');

// --- Renderer ---------------------------------------------------------------
const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  ui.fatal('Tu navegador no admite WebGL, necesario para dibujar el planeta.');
  throw e;
}
const PIXEL_RATIO = Math.min(devicePixelRatio, IS_MOBILE ? 1.5 : 2);
renderer.setPixelRatio(PIXEL_RATIO);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#03050a');

const camera = new THREE.PerspectiveCamera(IS_MOBILE ? 48 : 36, innerWidth / innerHeight, 0.01, 200);
const HOME_H = IS_MOBILE ? 3.6 : 2.6;
// Vista inicial: la longitud aproximada del visitante (según su zona horaria)
const homeLon = THREE.MathUtils.clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
camera.position.copy(latLonToVec3(22, homeLon, 11));

// Bloom (solo en escritorio: en móvil cuesta demasiado)
let composer = null;
if (!IS_MOBILE) {
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(PIXEL_RATIO);
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.45, 0.4, 0.86));
  composer.addPass(new OutputPass());
}

// --- Controles --------------------------------------------------------------
// OrbitControls solo para girar; el zoom es propio (por altitud y hacia el cursor).
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.enableZoom = false;
controls.autoRotate = false; // se activa al terminar la intro
const AUTO_SPEED = REDUCED_MOTION ? 0.08 : 0.28;

let follow = false;
let hTarget = null; // altitud hacia la que se mueve la cámara
let zoomRate = 8;
let idleTimer = null;
const IDLE_MS = 5000;

const armIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!follow) controls.autoRotate = true; }, IDLE_MS);
};
const stopIdle = () => { controls.autoRotate = false; clearTimeout(idleTimer); };
controls.addEventListener('start', stopIdle);
controls.addEventListener('end', armIdle);

const raycaster = new THREE.Raycaster();
const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1);
const _hit = new THREE.Vector3();
function surfaceAt(x, y) {
  raycaster.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  return raycaster.ray.intersectSphere(unitSphere, _hit);
}

/** Acerca/aleja multiplicando la altitud; al acercar, gira hacia el punto señalado. */
function zoomBy(factor, x, y) {
  const h = camera.position.length() - 1;
  const from = hTarget ?? h;
  const to = THREE.MathUtils.clamp(from * factor, MIN_H, MAX_H);
  if (factor < 1 && x != null && !follow) {
    const p = surfaceAt(x, y);
    if (p) {
      const c = camera.position.clone().normalize();
      const target = p.clone().normalize();
      const ang = c.angleTo(target);
      if (ang > 1e-9) {
        const axis = new THREE.Vector3().crossVectors(c, target).normalize();
        const f = THREE.MathUtils.clamp(1 - to / from, 0, 1) * 0.92;
        camera.position.applyAxisAngle(axis, ang * f);
      }
    }
  }
  hTarget = to;
  zoomRate = 8;
  stopIdle();
  armIdle();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  zoomBy(Math.exp(THREE.MathUtils.clamp(dy, -300, 300) * 0.0016), e.clientX, e.clientY);
}, { passive: false });

// Pellizco con dos dedos
const touches = new Map();
let pinchDist = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2 && pinchDist) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > 0) zoomBy(pinchDist / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    pinchDist = d;
  }
});
const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinchDist = null; };
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// --- Planeta ----------------------------------------------------------------
const manager = new THREE.LoadingManager();
let texturesReady = false;
manager.onProgress = (_, loaded, total) => ui.setProgress(loaded / total);
manager.onLoad = () => { texturesReady = true; };
manager.onError = () => {};

const earth = createEarth({
  scene, renderer, manager, isMobile: IS_MOBILE,
  onTextureError: (f) => ui.toast(`No se pudo cargar la textura ${f}`, 'warn', 'tex'),
});

const tiles = new SatelliteTiles({
  scene, camera, renderer, earthUniforms: earth.uniforms,
  onError: () => ui.toast('No se pudieron cargar algunas imágenes de satélite', 'warn', 'tiles'),
});

const sunDir = new THREE.Vector3();
function updateSun() {
  const { lat, lon } = subsolarPoint(new Date(time.now()));
  earth.setSunDirection(latLonToVec3(lat, lon, 1, sunDir));
}
updateSun();

// --- Capas ------------------------------------------------------------------
const size = () => ({ w: innerWidth, h: innerHeight });
const ctx = { scene, camera, renderer, ui, earth, time, isMobile: IS_MOBILE, size };
const quakes = new EarthquakesLayer(ctx);
const iss = new IssLayer(ctx);
const clouds = new CloudsLayer(ctx);
const layers = [clouds, quakes, iss];
for (const l of layers) {
  ui.registerSource(l.id, l.name);
  l.start();
}
ui.bindToggles({
  quakes: (on) => quakes.setVisible(on),
  iss: (on) => iss.setVisible(on),
  clouds: (on) => clouds.setVisible(on),
  labels: (on) => tiles.setLabels(on),
});
ui.bindTimeline(time);
time.onChange(() => {
  if (!time.live && follow) setFollow(false);
  ui.hideTooltip();
});
window.planeta = { camera, controls, layers, scene, tiles, time }; // útil para depurar desde la consola

// --- Seguir a la ISS --------------------------------------------------------
ui.onFollow(() => setFollow(!follow));
function setFollow(on) {
  if (on && !time.live) time.goLive();
  follow = on;
  ui.setFollow(on);
  if (on) {
    stopIdle();
    hTarget = Math.min(camera.position.length() - 1, IS_MOBILE ? 2.2 : 1.5);
    zoomRate = 2;
  } else {
    armIdle();
  }
}

// --- Puntero: tooltip al pasar el ratón o al tocar ---------------------------
let hover = null; // {x, y}
let down = null;
canvas.addEventListener('pointermove', (e) => {
  if (down && (touches.size > 1 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6)) {
    down.moved = true;
    if (follow) setFollow(false); // arrastrar = tomar el control
    ui.hideTooltip();
  }
  if (e.pointerType === 'mouse' && !down) hover = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, moved: touches.size > 1 };
});
canvas.addEventListener('pointerup', (e) => {
  const tap = down && !down.moved && e.pointerType !== 'mouse';
  down = null;
  if (tap) {
    const hit = pickAt(e.clientX, e.clientY, 18);
    if (hit) ui.showTooltip(hit.html, e.clientX, e.clientY);
    else ui.hideTooltip();
  }
});
canvas.addEventListener('pointerleave', () => { hover = null; ui.hideTooltip(); });
canvas.addEventListener('dblclick', (e) => zoomBy(0.35, e.clientX, e.clientY));

function pickAt(x, y, radius) {
  let best = null;
  for (const l of layers) {
    const hit = l.pick?.(x, y, radius);
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}

// --- Redimensionado -----------------------------------------------------------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

// --- Bucle ------------------------------------------------------------------
const clock = new THREE.Clock();
const tmpDir = new THREE.Vector3();
const tmpCur = new THREE.Vector3();
let started = false;
let lastPick = 0;
const halfFov = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

function startIntro() {
  started = true;
  ui.hideLoader();
  hTarget = HOME_H;
  zoomRate = 1.4;
  setTimeout(() => { if (!follow && !controls.autoRotate) armIdle(); }, 400);
}
// Si las texturas tardan demasiado, entra igualmente
setTimeout(() => { if (!started) startIntro(); }, 12000);

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  time.tick(dt);
  updateSun();

  for (const l of layers) l.update(dt);

  // Altitud: se interpola en escala logarítmica para que el zoom sea igual de suave a 10 000 km que a 2 km
  let h = camera.position.length() - 1;
  if (hTarget != null) {
    const k = 1 - Math.exp(-dt * zoomRate);
    h = Math.exp(Math.log(h) + (Math.log(hTarget) - Math.log(h)) * k);
    if (Math.abs(Math.log(h / hTarget)) < 0.002) { h = hTarget; hTarget = null; }
  }
  h = THREE.MathUtils.clamp(h, MIN_H, 12);
  if (follow && iss.state) {
    tmpDir.copy(iss.position).normalize();
    tmpCur.copy(camera.position).normalize().lerp(tmpDir, 1 - Math.exp(-dt * 2.2)).normalize();
    camera.position.copy(tmpCur);
  } else {
    camera.position.normalize();
  }
  camera.position.multiplyScalar(1 + h);

  // Planos de recorte ajustados a la altitud (precisión de profundidad al acercarse)
  camera.near = THREE.MathUtils.clamp(h * 0.3, 0.00002, 0.05);
  camera.far = 1 + h + 1.5;
  camera.updateProjectionMatrix();

  // Arrastrar mueve el suelo bajo el dedo a cualquier altitud
  controls.rotateSpeed = THREE.MathUtils.clamp((halfFov() * h) / Math.PI, 0.00001, 0.8);
  controls.autoRotateSpeed = AUTO_SPEED * THREE.MathUtils.clamp(h / HOME_H, 0.004, 1);
  controls.update();

  earth.setAltitude(h);
  tiles.update(innerHeight);

  if (composer) composer.render();
  else renderer.render(scene, camera);

  if (!started && texturesReady) startIntro();

  // Hover (como mucho ~20 veces por segundo)
  const now = performance.now();
  if (hover && now - lastPick > 50) {
    lastPick = now;
    const hit = pickAt(hover.x, hover.y, 10);
    canvas.style.cursor = hit ? 'pointer' : '';
    if (hit) ui.showTooltip(hit.html, hover.x, hover.y);
    else ui.hideTooltip();
  }
});
