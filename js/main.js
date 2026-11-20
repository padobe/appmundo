// Planeta en vivo — punto de entrada.
// Escena, cámara, controles y bucle. Los datos en vivo viven en "capas"
// (js/layers/*): cada una implementa start(), update(dt) y pick(x, y, r).
// Para añadir aviones, barcos o clima basta con crear otra capa y registrarla abajo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEarth } from './globe.js';
import { subsolarPoint } from './sun.js';
import { latLonToVec3 } from './geo.js';
import { ui } from './ui.js';
import { EarthquakesLayer } from './layers/earthquakes.js';
import { IssLayer } from './layers/iss.js';

const IS_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

ui.startClock();
if (innerWidth < 760) document.querySelector('.legend')?.removeAttribute('open');

// --- Renderer ---------------------------------------------------------------
const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  ui.fatal('Tu navegador no admite WebGL, necesario para dibujar el planeta.');
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_MOBILE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#03050a');

const camera = new THREE.PerspectiveCamera(IS_MOBILE ? 48 : 36, innerWidth / innerHeight, 0.01, 200);
const HOME_DIST = IS_MOBILE ? 4.6 : 3.6;
// Vista inicial: la longitud aproximada del visitante (según su zona horaria)
const homeLon = THREE.MathUtils.clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
camera.position.copy(latLonToVec3(22, homeLon, 11));

// --- Controles --------------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 1.25;
controls.maxDistance = 10;
controls.zoomSpeed = 0.7;
controls.autoRotate = false; // se activa al terminar la intro
controls.autoRotateSpeed = REDUCED_MOTION ? 0.08 : 0.28;

let follow = false;
let zoomTarget = null; // distancia hacia la que la cámara se acerca suavemente
let idleTimer = null;
const IDLE_MS = 5000;

const armIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!follow) controls.autoRotate = true; }, IDLE_MS);
};
controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(idleTimer); });
controls.addEventListener('end', armIdle);
canvas.addEventListener('wheel', () => { zoomTarget = null; }, { passive: true });

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

const sunDir = new THREE.Vector3();
function updateSun() {
  const { lat, lon } = subsolarPoint(new Date());
  earth.setSunDirection(latLonToVec3(lat, lon, 1, sunDir));
}
updateSun();
setInterval(updateSun, 10000);

// --- Capas ------------------------------------------------------------------
const size = () => ({ w: innerWidth, h: innerHeight });
const ctx = { scene, camera, renderer, ui, earth, isMobile: IS_MOBILE, size };
const quakes = new EarthquakesLayer(ctx);
const iss = new IssLayer(ctx);
const layers = [quakes, iss];
window.planeta = { camera, controls, layers, scene }; // útil para depurar desde la consola
for (const l of layers) {
  ui.registerSource(l.id, l.name);
  l.start();
}

// --- Seguir a la ISS --------------------------------------------------------
ui.onFollow(() => setFollow(!follow));
function setFollow(on) {
  follow = on;
  ui.setFollow(on);
  if (on) {
    controls.autoRotate = false;
    clearTimeout(idleTimer);
    zoomTarget = Math.min(camera.position.length(), IS_MOBILE ? 3.2 : 2.5);
  } else {
    armIdle();
  }
}

// --- Puntero: tooltip al pasar el ratón o al tocar ---------------------------
let hover = null; // {x, y}
let down = null;
canvas.addEventListener('pointermove', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
    down.moved = true;
    if (follow) setFollow(false); // arrastrar = tomar el control
    ui.hideTooltip();
  }
  if (e.pointerType === 'mouse' && !down) hover = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, moved: false, type: e.pointerType };
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
});

// --- Bucle ------------------------------------------------------------------
const clock = new THREE.Clock();
const tmpDir = new THREE.Vector3();
const tmpCur = new THREE.Vector3();
let started = false;
let lastPick = 0;

function startIntro() {
  started = true;
  ui.hideLoader();
  zoomTarget = HOME_DIST;
  setTimeout(() => { if (!follow && !controls.autoRotate) armIdle(); }, 400);
}
// Si las texturas tardan demasiado, entra igualmente
setTimeout(() => { if (!started) startIntro(); }, 12000);

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);

  for (const l of layers) l.update(dt);

  let dist = camera.position.length();
  if (zoomTarget != null) {
    dist += (zoomTarget - dist) * (1 - Math.exp(-dt * 1.8));
    if (Math.abs(dist - zoomTarget) < 0.005) zoomTarget = null;
  }
  if (follow && iss.state) {
    tmpDir.copy(iss.position).normalize();
    tmpCur.copy(camera.position).normalize().lerp(tmpDir, 1 - Math.exp(-dt * 2.2)).normalize();
    camera.position.copy(tmpCur);
  } else {
    camera.position.normalize();
  }
  camera.position.multiplyScalar(dist);

  // Girar más despacio cuanto más cerca
  controls.rotateSpeed = THREE.MathUtils.clamp(0.12 + 0.22 * (dist - 1), 0.12, 0.8);
  controls.update();

  renderer.render(scene, camera);

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
