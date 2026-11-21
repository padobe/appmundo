// Planeta en vivo — punto de entrada.
// Escena, cámara (zoom, inclinación, vuelos), bloom, bucle y registro de capas.
// Las capas de datos viven en js/layers/*: start(), update(dt), pick(x, y, r), setVisible(on).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createEarth } from './globe.js';
import { SatelliteTiles, TERRAIN_EXAGGERATION } from './tiles.js';
import { Sky } from './sky.js';
import { subsolarPoint } from './sun.js';
import { latLonToVec3, vec3ToLatLon, greatCircle } from './geo.js';
import { Timeline } from './timeline.js';
import { ui } from './ui.js';
import { EarthquakesLayer } from './layers/earthquakes.js';
import { IssLayer } from './layers/iss.js';
import { CloudsLayer } from './layers/clouds.js';
import { SatellitesLayer } from './layers/satellites.js';
import { AuroraLayer } from './layers/aurora.js';
import { WindLayer } from './layers/wind.js';
import { EonetLayer } from './layers/eonet.js';
import { GdacsLayer } from './layers/events.js';
import { PlacePanel } from './place.js';
import { Tour } from './tour.js';
import { PhotoLayer } from './layers/photo.js';
import { Eclipses } from './eclipses.js';
import * as ephem from './ephemeris.js';
import { describePlace } from './regions.js';

const IS_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_CLEARANCE = 0.00003; // ≈ 190 m sobre el terreno
const MAX_H = 9;
const R_M = 6371000;

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
scene.background = new THREE.Color('#02040a');

const camera = new THREE.PerspectiveCamera(IS_MOBILE ? 48 : 36, innerWidth / innerHeight, 0.01, 200);
const HOME_H = IS_MOBILE ? 3.6 : 2.6;
const homeLon = THREE.MathUtils.clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
camera.position.copy(latLonToVec3(22, homeLon, 7));

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
// OrbitControls solo para girar; zoom, inclinación y vuelos son propios.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.enableZoom = false;
controls.autoRotate = false;
const AUTO_SPEED = REDUCED_MOTION ? 0.08 : 0.28;

let follow = false;
let hTarget = null;
let zoomRate = 8;
let idleTimer = null;
let tilt = 0; // inclinación actual (rad)
let userTilt = null; // inclinación elegida por el usuario (null = automática)
let terrainM = 0; // altura del terreno bajo la cámara (m, ya exagerada)
const IDLE_MS = 5000;

const smooth = THREE.MathUtils.smoothstep;
// Vista cenital por defecto: la inclinación solo cambia si el usuario la pide (Mayús+flechas, arrastre)
const autoTilt = () => 0;
const maxTilt = (h) => 1.32 * (1 - smooth(h, 0.02, 0.4));

const armIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Solo gira sola con el globo entero a la vista: acercada, molesta
    const h = camera.position.length() - 1;
    if (!follow && !rig.flight && h > 1.2 && !document.body.classList.contains('event-mode')) controls.autoRotate = true;
  }, IDLE_MS);
};
const stopIdle = () => { controls.autoRotate = false; clearTimeout(idleTimer); };
controls.addEventListener('start', () => { stopIdle(); anchor = null; orbit.on = false; });
controls.addEventListener('end', armIdle);

const raycaster = new THREE.Raycaster();
const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1);
const _hit = new THREE.Vector3();
function surfaceAt(x, y) {
  raycaster.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  return raycaster.ray.intersectSphere(unitSphere, _hit);
}

// Zoom anclado: el punto del suelo bajo el cursor se queda quieto en pantalla mientras
// la cámara sube o baja (como en Google Earth), sin giros bruscos.
let anchor = null; // { x, y, p: punto de la superficie bajo el cursor }
const _q = new THREE.Quaternion();

/** Acerca/aleja multiplicando la altitud sobre el terreno, anclado al punto bajo el cursor. */
function zoomBy(factor, x, y) {
  const ground = terrainM / R_M;
  const h = camera.position.length() - 1;
  const from = hTarget ?? h;
  const to = THREE.MathUtils.clamp(ground + (from - ground) * factor, ground + MIN_CLEARANCE, MAX_H);
  if (x != null && !follow) {
    const p = surfaceAt(x, y);
    // Se conserva el ancla mientras dure la ráfaga de rueda sobre el mismo punto
    if (p && !(anchor && Math.hypot(anchor.x - x, anchor.y - y) < 3)) anchor = { x, y, p: p.clone().normalize() };
    if (!p) anchor = null;
  }
  hTarget = to;
  zoomRate = 8;
  stopIdle();
  armIdle();
}

const interrupt = () => { tour.stop(); rig.cancel(); orbit.on = false; };

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  interrupt();
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  zoomBy(Math.exp(THREE.MathUtils.clamp(dy, -300, 300) * 0.0016), e.clientX, e.clientY);
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Inclinación: clic derecho o Ctrl/Mayús + arrastrar; en móvil, dos dedos arriba/abajo
let tiltDrag = null;
// Órbita cinematográfica: giro alrededor del evento aplicado solo al dibujar (se deshace al final del fotograma)
const orbit = { on: false, axis: new THREE.Vector3(), heading: 0, q: new THREE.Quaternion(), applied: false };
canvas.addEventListener('pointerdown', (e) => {
  interrupt();
  if (e.pointerType === 'mouse' && (e.button === 2 || (e.button === 0 && (e.ctrlKey || e.shiftKey)))) {
    tiltDrag = { y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    stopIdle();
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!tiltDrag) return;
  const h = camera.position.length() - 1;
  userTilt = THREE.MathUtils.clamp((userTilt ?? tilt) - (e.clientY - tiltDrag.y) * 0.005, 0, maxTilt(h));
  tiltDrag.y = e.clientY;
});
const endTilt = () => { if (tiltDrag) { tiltDrag = null; armIdle(); } };
canvas.addEventListener('pointerup', endTilt);
canvas.addEventListener('pointercancel', endTilt);

const touches = new Map();
let pinch = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), y: (a.y + b.y) / 2 };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2 && pinch) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const my = (a.y + b.y) / 2;
    const ratio = pinch.d / d;
    if (Math.abs(ratio - 1) < 0.012 && Math.abs(my - pinch.y) > 1) {
      const h = camera.position.length() - 1;
      userTilt = THREE.MathUtils.clamp((userTilt ?? tilt) - (my - pinch.y) * 0.006, 0, maxTilt(h));
    } else if (d > 0) {
      zoomBy(ratio, (a.x + b.x) / 2, my);
    }
    pinch = { d, y: my };
  }
});
const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// --- Vuelos de cámara (tour, búsqueda) ---------------------------------------
const rig = {
  flight: null,
  driftSpeed: 0,
  /** Vuela a un punto. Devuelve true al llegar, false si se interrumpe. */
  flyTo({ lat, lon, h, tilt: tilt1 = 0, duration = 3 }) {
    this.cancel();
    if (follow) setFollow(false);
    stopIdle();
    hTarget = null;
    const d0 = camera.position.clone().normalize();
    const d1 = latLonToVec3(lat, lon, 1);
    const h0 = camera.position.length() - 1;
    const ang = d0.angleTo(d1);
    const peak = Math.max(h0, h, Math.min(2.4, ang * 1.1));
    return new Promise((resolve) => {
      this.flight = { d0, d1, h0, h1: h, peak, tilt0: tilt, tilt1, t: 0, dur: duration, resolve };
    });
  },
  cancel() {
    if (this.flight) { this.flight.resolve(false); this.flight = null; }
  },
  drift(speed) { this.driftSpeed = speed; },
  /** Órbita lenta alrededor de un eje (punto de la superficie); se para al tocar el mapa. */
  setOrbit(on, axis) { orbit.on = on; if (axis) orbit.axis.copy(axis); },
};
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// --- Planeta, teselas y cielo ---------------------------------------------------
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
const sky = new Sky({ scene, camera, renderer, earth, time, isMobile: IS_MOBILE });

const sunDir = new THREE.Vector3();
function updateSun() {
  const date = new Date(time.now());
  if (ephem.ready()) {
    ephem.sunMoon(date, sunDir, earth.uniforms.uMoonPos.value);
    earth.setSunDirection(sunDir);
    earth.updateEclipse(earth.uniforms.uMoonPos.value);
  } else {
    const { lat, lon } = subsolarPoint(date);
    earth.setSunDirection(latLonToVec3(lat, lon, 1, sunDir));
  }
}
updateSun();

// --- Capas ------------------------------------------------------------------
const size = () => ({ w: innerWidth, h: innerHeight });
const ctx = { scene, camera, renderer, ui, earth, time, tiles, isMobile: IS_MOBILE, size, fogScale: 1 };
const quakes = new EarthquakesLayer(ctx);
const iss = new IssLayer(ctx);
const clouds = new CloudsLayer(ctx);
const sats = new SatellitesLayer(ctx);
const aurora = new AuroraLayer(ctx);
const wind = new WindLayer(ctx);
const eonet = new EonetLayer(ctx, { open: openEvent });
const photo = new PhotoLayer(ctx);
// Vista detallada de eventos (GDACS): el módulo pesado se descarga solo al abrir el primero
let eventView = null;
async function openEvent(evt) {
  tour.stop();
  try {
    if (!eventView) {
      const m = await import('./events/view.js');
      eventView = new m.EventView(ctx, { rig, homeH: HOME_H, layer: gdacs, env: { clouds, photo } });
    }
    await eventView.open(evt);
  } catch (e) {
    console.warn('[evento]', e);
    ui.toast('No se pudo abrir la vista del evento', 'warn', 'event-view');
  }
}
const gdacs = new GdacsLayer(ctx, { open: openEvent });
const layers = [photo, clouds, aurora, wind, quakes, eonet, gdacs, sats, iss];
// Con la foto real de día, las nubes en directo solo se dibujan de noche (si no, se duplican)
photo.onChange = () => clouds.setNightOnly(photo.active);
time.onChange(() => clouds.setNightOnly(photo.active && (time.live || time.span === 'day')));
for (const l of layers) ui.registerSource(l.id, l.name);
// Lo imprescindible arranca ya; lo pesado espera a que el planeta esté en pantalla
quakes.start();
iss.start();
let deferredStarted = false;
function startDeferred() {
  if (deferredStarted) return;
  deferredStarted = true;
  earth.loadFull();
  sky.load();
  for (const l of [photo, clouds, aurora, eonet, gdacs, sats, wind]) l.start();
  ephem.loadAstronomy().catch(() => ui.toast('No se pudo cargar el cálculo de planetas y eclipses', 'warn', 'astro'));
}
let noCloudPrev = null;
ui.bindToggles({
  quakes: (on) => quakes.setVisible(on),
  iss: (on) => iss.setVisible(on),
  sats: (on) => sats.setVisible(on),
  'sat-visual': (on) => sats.setGroup('visual', on),
  'sat-gnss': (on) => sats.setGroup('gnss', on),
  'sat-geo': (on) => sats.setGroup('geo', on),
  'sat-starlink': (on) => sats.setGroup('starlink', on),
  aurora: (on) => aurora.setVisible(on),
  wind: (on) => wind.setVisible(on),
  eonet: (on) => eonet.setVisible(on),
  gdacs: (on) => gdacs.setVisible(on),
  clouds: (on) => clouds.setVisible(on),
  constellations: (on) => sky.setConstellations(on),
  planets: (on) => sky.setPlanets(on),
  photo: (on) => photo.setVisible(on),
  moon: (on) => sky.setMoon(on),
  terrain: (on) => tiles.setTerrain(on),
  labels: (on) => tiles.setLabels(on),
  // Atajo: apaga a la vez las nubes en directo y la foto de ayer (que lleva las nubes pintadas)
  nocloud: (on) => {
    const set = (id, v) => {
      const i = document.querySelector(`[data-layer="${id}"]`);
      if (i && i.checked !== v) { i.checked = v; i.dispatchEvent(new Event('change')); }
    };
    if (on) {
      noCloudPrev = { clouds: document.querySelector('[data-layer="clouds"]')?.checked, photo: document.querySelector('[data-layer="photo"]')?.checked };
      set('clouds', false); set('photo', false);
    } else if (noCloudPrev) {
      const both = !noCloudPrev.clouds && !noCloudPrev.photo; // ya estaban apagadas (sesión anterior): se vuelven a encender
      set('clouds', both || noCloudPrev.clouds); set('photo', both || noCloudPrev.photo);
      noCloudPrev = null;
    }
  },
});
ui.bindTimeline(time);
time.onChange(() => {
  if (!time.live && follow) setFollow(false);
  ui.hideTooltip();
});

const place = new PlacePanel(ctx, { rig, layers: { quakes, eonet, aurora, sats } });
const tour = new Tour(ctx, { rig, layers: { quakes, eonet, aurora, iss }, setFollow: (on) => setFollow(on) });
document.getElementById('btn-tour').addEventListener('click', () => {
  if (!time.live) time.goLive();
  if (tour.running) tour.stop(); else tour.start();
});
const eclipses = new Eclipses(ctx, { rig, sky });
document.getElementById('btn-eclipses').addEventListener('click', () => { tour.stop(); eclipses.open(); });
ui.bindDetail();

// --- Vídeo en directo de la ISS (canal oficial de la NASA en IBM Video; solo se carga al abrirlo)
const VIDEO_SRC = 'https://video.ibm.com/embed/9408562?html5ui=1&autoplay=true&volume=0';
function toggleVideo(force) {
  const panel = document.getElementById('video-panel');
  const frame = document.getElementById('video-frame');
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  frame.src = open ? VIDEO_SRC : 'about:blank';
  document.getElementById('btn-video').setAttribute('aria-expanded', String(open));
  if (open) document.getElementById('video-close').focus();
}
document.getElementById('btn-video').addEventListener('click', () => toggleVideo());
document.getElementById('video-close').addEventListener('click', () => toggleVideo(false));

// Caché en disco de las teselas (sw.js): las zonas ya vistas cargan al instante, también otro día
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch((e) => console.warn('[sw]', e));
}
window.planeta = { camera, controls, layers, scene, tiles, time, sky, rig, tour, place, eclipses, photo, gdacs }; // depuración

// --- Seguir a la ISS --------------------------------------------------------
ui.onFollow(() => { tour.stop(); setFollow(!follow); });
function setFollow(on) {
  if (on && !time.live) time.goLive();
  follow = on;
  ui.setFollow(on);
  if (on) {
    stopIdle();
    rig.cancel();
    hTarget = Math.min(camera.position.length() - 1, IS_MOBILE ? 2.2 : 1.5);
    zoomRate = 2;
  } else {
    armIdle();
  }
}

// --- Puntero: tooltip al pasar el ratón o al tocar ---------------------------
let hover = null;
let down = null;
canvas.addEventListener('pointermove', (e) => {
  if (down && (touches.size > 1 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6)) {
    down.moved = true;
    if (follow && !tiltDrag) setFollow(false);
    ui.hideTooltip();
  }
  if (e.pointerType === 'mouse' && !down) hover = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, moved: touches.size > 1 };
});
canvas.addEventListener('pointerup', (e) => {
  const click = down && !down.moved && e.button === 0;
  const touch = e.pointerType !== 'mouse';
  down = null;
  if (!click) return;
  const hit = pickAt(e.clientX, e.clientY, touch ? 18 : 10);
  if (hit?.select) { hit.select(); ui.hideTooltip(); return; }
  if (touch) {
    if (hit) ui.showTooltip(hit.html, e.clientX, e.clientY);
    else ui.hideTooltip();
  }
});
canvas.addEventListener('pointerleave', () => { hover = null; ui.hideTooltip(); });
canvas.addEventListener('dblclick', (e) => zoomBy(0.35, e.clientX, e.clientY));

const pickables = [...layers, sky];
function pickAt(x, y, radius) {
  let best = null;
  for (const l of pickables) {
    const hit = l.pick?.(x, y, radius);
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

// --- Teclado ------------------------------------------------------------------
// Flechas: girar · Mayús + flechas: inclinar · + / −: zoom · Espacio: reproducir/pausar
// L: directo · T: tour · F: seguir ISS · V: vídeo ISS · E: eclipses · B: buscar · C: capas · ?: ayuda
const keys = new Set();
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
const help = document.getElementById('help-dialog');
function toggleHelp(force) {
  const open = force ?? !help.open;
  if (open && !help.open) help.showModal();
  if (!open && help.open) help.close();
}
document.getElementById('btn-help').addEventListener('click', () => toggleHelp(true));
document.getElementById('help-close').addEventListener('click', () => toggleHelp(false));
addEventListener('keydown', (e) => {
  if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
    if (e.target.closest?.('.timeline, .layers, dialog')) return; // controles con sus propias flechas
    keys.add(e.shiftKey ? `tilt-${k}` : k);
    interrupt();
    stopIdle();
    e.preventDefault();
    return;
  }
  const onButton = e.target.closest?.('button, a, summary, label');
  switch (k) {
    case '+': case '=': zoomBy(0.7); break;
    case '-': case '_': zoomBy(1.4); break;
    case ' ': if (onButton) return; time.togglePlay(); e.preventDefault(); break;
    case 'l': case 'L': time.goLive(); break;
    case 't': case 'T': if (!time.live) time.goLive(); if (tour.running) tour.stop(); else tour.start(); break;
    case 'f': case 'F': tour.stop(); setFollow(!follow); break;
    case 'v': case 'V': toggleVideo(); break;
    case 'e': case 'E': tour.stop(); eclipses.open(); break;
    case 'b': case 'B': case '/': document.getElementById('search-input').focus(); e.preventDefault(); break;
    case 'c': case 'C': { const d = document.querySelector('.layers'); d.open = !d.open; break; }
    case '?': toggleHelp(); break;
    case 'Escape':
      tour.stop();
      ui.hideDetail();
      ui.hideTooltip();
      toggleVideo(false);
      break;
    default: return;
  }
});
addEventListener('keyup', (e) => { keys.delete(e.key); keys.delete(`tilt-${e.key}`); });
addEventListener('blur', () => keys.clear());

const _axis = new THREE.Vector3();
function applyKeys(dt, h, ground) {
  if (!keys.size) return;
  const speed = THREE.MathUtils.clamp((h - ground) * 0.6, 0.00004, 1.2) * dt; // más lento cerca del suelo
  const up = camera.position.clone().normalize();
  for (const k of keys) {
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      camera.position.applyAxisAngle(yAxis, (k === 'ArrowLeft' ? -1 : 1) * speed);
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      _axis.crossVectors(up, yAxis).normalize();
      if (_axis.lengthSq() < 0.5) continue;
      const lat = Math.asin(up.y);
      const step = (k === 'ArrowUp' ? 1 : -1) * speed;
      if (Math.abs(lat + step) < 1.45) camera.position.applyAxisAngle(_axis, -step);
    } else if (k === 'tilt-ArrowUp' || k === 'tilt-ArrowDown') {
      userTilt = THREE.MathUtils.clamp((userTilt ?? tilt) + (k === 'tilt-ArrowUp' ? 1 : -1) * dt * 0.8, 0, maxTilt(h));
    }
  }
}

// Anuncio para lectores de pantalla de qué se está viendo (cuando la cámara se para)
let lastAnnounce = 0, lastCamForAnnounce = new THREE.Vector3();
function announceView(now, h) {
  if (now - lastAnnounce < 2500) return;
  if (camera.position.distanceTo(lastCamForAnnounce) < 1e-4 * Math.max(h, 0.01)) return;
  if (hTarget != null || rig.flight || keys.size) return;
  lastAnnounce = now;
  lastCamForAnnounce.copy(camera.position);
  const { lat, lon } = vec3ToLatLon(camera.position);
  const where = describePlace(lat, lon, earth.isWater(lat, lon)).name;
  const km = Math.round(h * 6371);
  ui.announce(`Vista sobre ${where}, a ${km.toLocaleString('es-ES')} kilómetros de altura.`);
}

// --- Bucle ------------------------------------------------------------------
const clock = new THREE.Clock();
const tmpDir = new THREE.Vector3();
const tmpCur = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);
const fogColor = new THREE.Color();
let started = false;
let lastPick = 0;
const halfFov = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

function startIntro() {
  started = true;
  ui.hideLoader();
  hTarget = HOME_H;
  zoomRate = 2.6;
  setTimeout(startDeferred, 300);
  setTimeout(() => { if (!follow && !controls.autoRotate) armIdle(); }, 400);
}
setTimeout(() => { if (!started) startIntro(); }, 8000);

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  time.tick(dt);
  updateSun();
  for (const l of layers) l.update(dt);
  place.update();
  eclipses.update();
  eventView?.update();
  earth.uniforms.uTime.value += dt;

  // Terreno bajo la cámara (para no atravesar montañas)
  const sub = vec3ToLatLon(camera.position);
  // Relieve exagerado desde lejos (se lee mejor) y a escala real cerca del suelo (sin estirar la foto)
  if (tiles.terrainOn) {
    // En modo evento el relieve se exagera más (sube suavemente: las montañas «crecen»)
    const ex = ctx.reliefBoost || 1 + (TERRAIN_EXAGGERATION - 1) * smooth(camera.position.length() - 1, 0.004, 0.04);
    tiles.exag.value += (ex - tiles.exag.value) * (ctx.reliefBoost ? 1 - Math.exp(-dt * 1.5) : 1);
  }
  terrainM = tiles.terrainOn ? tiles.heightAt(sub.lat, sub.lon) * tiles.exag.value : 0;
  const ground = terrainM / R_M;

  let h = camera.position.length() - 1;
  let tiltTarget;
  const f = rig.flight;
  if (f) {
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    const e = ease(k);
    greatCircle(f.d0, f.d1, e, tmpDir);
    camera.position.copy(tmpDir);
    const l0 = Math.log(f.h0), lm = Math.log(f.peak), l1 = Math.log(f.h1);
    h = Math.exp((1 - e) ** 2 * l0 + 2 * e * (1 - e) * lm + e * e * l1);
    tiltTarget = f.tilt0 + (f.tilt1 - f.tilt0) * e;
    if (k >= 1) {
      rig.flight = null;
      userTilt = f.tilt1 > 0 ? f.tilt1 : null;
      f.resolve(true);
    }
  } else {
    if (hTarget != null) {
      const kz = 1 - Math.exp(-dt * zoomRate);
      const a = Math.max(h - ground, 1e-6), b = Math.max(hTarget - ground, 1e-6);
      h = ground + Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * kz);
      if (Math.abs(Math.log(a / b)) < 0.002) { h = hTarget; hTarget = null; }
    }
    if (follow && iss.state) {
      tmpDir.copy(iss.position).normalize();
      tmpCur.copy(camera.position).normalize().lerp(tmpDir, 1 - Math.exp(-dt * 2.2)).normalize();
      camera.position.copy(tmpCur);
    } else {
      camera.position.normalize();
      if (rig.driftSpeed) camera.position.applyAxisAngle(yAxis, rig.driftSpeed * dt);
      applyKeys(dt, h, ground);
    }
    if (h > 0.3) userTilt = null;
    tiltTarget = userTilt ?? autoTilt(h);
  }
  h = THREE.MathUtils.clamp(h, ground + MIN_CLEARANCE, 12);
  camera.position.multiplyScalar(1 + h);
  tilt += (Math.min(tiltTarget, maxTilt(h)) - tilt) * (1 - Math.exp(-dt * 5));

  // Planos de recorte según la altura (Luna y geoestacionarios necesitan un plano lejano amplio)
  camera.near = THREE.MathUtils.clamp((h - ground) * 0.3, 0.000015, 0.05);
  camera.far = h > 0.3 ? h + 26 : 1 + h + 1.5;
  camera.updateProjectionMatrix();

  controls.enabled = !rig.flight;
  controls.rotateSpeed = THREE.MathUtils.clamp((halfFov() * (h - ground)) / Math.PI, 0.00001, 0.8);
  controls.autoRotateSpeed = AUTO_SPEED * THREE.MathUtils.clamp(h / HOME_H, 0.004, 1);
  controls.update();
  if (tilt > 0.0005) camera.rotateX(tilt);

  // Zoom anclado: gira la cámara para que el punto elegido vuelva a quedar bajo el cursor
  if (anchor && hTarget != null && !rig.flight && !follow) {
    camera.updateMatrixWorld();
    const q = surfaceAt(anchor.x, anchor.y);
    if (q) {
      _q.setFromUnitVectors(q.normalize(), anchor.p);
      camera.position.applyQuaternion(_q);
      camera.quaternion.premultiply(_q);
    }
  } else if (hTarget == null) {
    anchor = null;
  }

  if (orbit.on && !rig.flight) orbit.heading += dt * 0.07;
  else if (!orbit.on) orbit.heading *= Math.exp(-dt * 2.5);
  orbit.applied = Math.abs(orbit.heading) > 1e-4;
  if (orbit.applied) {
    orbit.q.setFromAxisAngle(orbit.axis, orbit.heading);
    camera.position.applyQuaternion(orbit.q);
    camera.quaternion.premultiply(orbit.q);
    camera.updateMatrixWorld();
  }
  eventView?.afterCamera();

  earth.setAltitude(h);
  sky.update(dt, h);
  tiles.fog.value = (1 - smooth(h, 0.01, 0.15)) * 0.1 * ctx.fogScale;
  tiles.fogColor.value.copy(sky.horizonColor(fogColor));
  tiles.raw.value = 1 - smooth(h - ground, 0.006, 0.04); // por debajo de ~40-250 km: foto de día siempre, nítida
  tiles.update(innerHeight * Math.min(PIXEL_RATIO, 1.75)); // píxeles reales: nitidez en pantallas de alta densidad

  if (composer) composer.render();
  else renderer.render(scene, camera);
  eclipses.renderInset(renderer);
  announceView(performance.now(), h);

  if (!started && texturesReady) startIntro();

  const now = performance.now();
  if (hover && now - lastPick > 50) {
    lastPick = now;
    const hit = pickAt(hover.x, hover.y, 10);
    canvas.style.cursor = hit ? 'pointer' : '';
    if (hit) ui.showTooltip(hit.html, hover.x, hover.y);
    else ui.hideTooltip();
  }
  // Se deshace el giro de la órbita: la lógica del siguiente fotograma parte de la cámara sin girar
  if (orbit.applied) {
    orbit.q.invert();
    camera.position.applyQuaternion(orbit.q);
    camera.quaternion.premultiply(orbit.q);
  }
});
