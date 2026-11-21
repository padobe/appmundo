// Vista detallada común: vuelo de cámara al terreno, panel con datos y fuente, línea de tiempo
// del evento y gráfica. Cada fenómeno aporta un módulo (ver modules.js); esto no sabe de tipos.
// Se carga con import() la primera vez que se abre un evento.
import * as THREE from 'three';
import { escapeHtml, timeAgo } from '../net.js';
import { TYPES, ALERT } from './gdacs.js';
import { getModule } from './modules.js';
import { EventChart } from './chart.js';
import { disposeTree, decalBox, paintDecal } from './draw.js';
import { latLonToVec3, vec3ToLatLon } from '../geo.js';
import { fxClock, setLineResolution, wallObject, beaconObject, groundAt } from './fx.js';
import { EventHud, countUp } from './hud.js';

// Preferencias de efectos (se recuerdan mientras la página está abierta)
const PREFS = { cine: true, relief: true, hud: true };
const RELIEF = { VO: 3.5, TC: 1.6, FL: 1.8, EO: 2.2 }; // exageración del relieve en modo evento (por defecto 2,5)

const HOUR = 3600000;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const fmtShort = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtTime = (ms) => `${fmt.format(ms)} UTC`;
const D2R = Math.PI / 180;
const DEFAULT_SPAN = { EQ: 1.2, TC: 10, FL: 2, WF: 0.4, VO: 0.4, DR: 6 }; // grados, mientras llegan los datos
const MIN_DIST = { EQ: 0.012, TC: 0.05, FL: 0.01, WF: 0.005, VO: 0.005, DR: 0.03 };
const maxTilt = (h) => 1.32 * (1 - THREE.MathUtils.smoothstep(h, 0.02, 0.4)); // igual que main.js

/** Ventana de la línea de tiempo: inicio–fin del evento, sin pasar de ahora. Los eventos
 *  puntuales (terremotos) se muestran de 3 h antes a 21 h después. */
export function eventWindow(evt, now = Date.now()) {
  let start, end;
  if (evt.to - evt.from < 6 * HOUR) {
    start = evt.from - 3 * HOUR;
    end = Math.min(evt.from + 21 * HOUR, now);
  } else {
    start = evt.from;
    end = Math.min(evt.to, now);
  }
  if (end - start < HOUR) start = end - 6 * HOUR;
  return { start, end };
}

export class EventView {
  constructor(ctx, { rig, homeH, layer, env }) {
    this.env = env; // { clouds, photo }: se apagan en modo evento (tapan el terreno) y se pueden volver a encender
    this.ctx = ctx;
    this.rig = rig;
    this.homeH = homeH;
    this.layer = layer;
    this.token = 0;
    this.evt = null;
    this.group = null;
    this.beacon = null;
    this.bLat = this.bLon = null;
    this.layers = [];
    this.chart = null;
    this.lastUpdate = 0;
  }

  async open(evt) {
    const { ui, time } = this.ctx;
    ui.hideDetail(); // cierra cualquier otra ficha (terremoto, eclipses…)
    this.teardown();
    const my = ++this.token;
    this.evt = evt;
    this.win = eventWindow(evt);
    this.layer.focus(evt.key);
    const close = () => { if (this.token === my) this.teardown(); };
    close.exclusive = true; // si otra ficha ocupa el panel, la vista se recoge sola
    ui.showDetail(this.shell(evt, '<p class="pl-loading">Cargando datos del evento…</p>'), close);
    this.bindBack();
    document.body.classList.add('event-mode');
    this.ctx.tiles.lift.value = 1;
    if (this.env && !this.envSaved) {
      this.envSaved = { clouds: this.env.clouds.visible, photo: this.env.photo.visible };
      this.env.clouds.setVisible(false);
      this.env.photo.setVisible(false);
    }
    this.ctx.fogScale = 0.3; // menos bruma: la imagen se ve nítida y con relieve

    this.travel(evt);

    // Vuelo provisional mientras llegan los datos; se afina con el encuadre real
    let state = 'flying';
    const d0 = (DEFAULT_SPAN[evt.type] ?? 2) / 2;
    const pre = this.framing({ w: evt.lon - d0, e: evt.lon + d0, s: evt.lat - d0, n: evt.lat + d0 }, evt);
    this.rig.flyTo({ ...pre, duration: 3 })
      .then((ok) => { if (state === 'flying') state = ok ? 'arrived' : 'cancelled'; });

    const mod = getModule(evt.type);
    let data;
    try {
      data = await mod.loadData(evt);
    } catch (e) {
      console.warn('[evento]', e);
      data = { errors: ['No se pudieron cargar los datos del evento.'], failed: true };
    }
    if (this.token !== my) return;

    // Algunos módulos tienen su propia ventana temporal (p. ej. incendios: desde la primera detección)
    try {
      const w = mod.window?.(data, evt);
      if (w && w.end > w.start) { this.win = w; this.travel(evt); }
    } catch { /* se mantiene la ventana por defecto */ }

    let box = null;
    try { box = mod.frame?.(data, evt) || null; } catch { /* encuadre por defecto */ }
    const d1 = (DEFAULT_SPAN[evt.type] ?? 2) / 4;
    const view = this.framing(box || { w: evt.lon - d1, e: evt.lon + d1, s: evt.lat - d1, n: evt.lat + d1 }, evt);
    const tiles = this.ctx.tiles;

    this.group = new THREE.Group();
    try {
      this.layers = mod.layers(data, evt, { scale: view.dist, tiles }) || [];
    } catch (e) {
      console.warn('[evento] capas', e);
      data.errors = [...(data.errors || []), 'No se pudo dibujar la geometría del evento.'];
    }

    // Zonas pequeñas: se pintan sobre las teselas (siguen el relieve). Zonas grandes: líneas 3D.
    const dl = this.layers.filter((l) => l.decal);
    const dbox = dl.length ? decalBox(dl) : null;
    const span = dbox ? Math.max(dbox.n - dbox.s, (dbox.e - dbox.w) * Math.cos(((dbox.n + dbox.s) / 2) * D2R)) : 99;
    this.decalMode = !!dbox && span <= 14 && !!tiles; // hasta ~14°: pintado sobre el relieve (4096 px ≈ 400 m/píxel)
    this.decalBox = this.decalMode ? dbox : null;
    const always = this.layers.filter((l) => l.decal?.always);
    this.forced = !this.decalMode && always.length > 0 && !!tiles;
    if (this.forced) { this.decalMode = true; this.decalBox = decalBox(always); }
    this.decalRes = !this.ctx.isMobile && this.ctx.renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
    this.decalKey = '';
    this.off = new Set();
    for (const l of this.layers) {
      const painted = this.decalMode && l.decal && (!this.forced || l.decal.always);
      if (l.object && (!painted || l.keep3d)) this.group.add(l.object);
      l.hotspots?.userData.setShowOld(!this.decalMode); // con mapa de calor en el suelo, en 3D solo brilla lo activo
      if (l.wall && l.polys?.length && l.polys.length <= 12) { // cortina de luz (no en áreas troceadas en píxeles)
        l.wallObj = wallObject(l.polys, { color: l.color, tiles, height: THREE.MathUtils.clamp(view.dist * 0.035, 0.00015, 0.02), opacity: this.decalMode ? 0.6 : 0.35 });
        this.group.add(l.wallObj);
      }
    }
    // Baliza en el epicentro / centroide / posición del ciclón
    this.mod = mod; this.data = data;
    this.beaconSize = view.dist;
    this.beacon = mod.beacon === false ? null : beaconObject({ color: evt.color || ALERT[evt.alert].color, size: view.dist, tiles, ringScale: evt.type === 'EQ' ? 1.8 : 1 });
    if (this.beacon) { this.beacon.userData.place(evt.lat, evt.lon); this.group.add(this.beacon); }
    this.openedAt = performance.now();
    this.lastGround = 0;
    this.ctx.scene.add(this.group);
    // HUD: mira sobre la zona y etiquetas ancladas al relieve
    this.frameBox = box || { w: evt.lon - d1, e: evt.lon + d1, s: evt.lat - d1, n: evt.lat + d1 };
    let labels = [];
    try { labels = mod.labels?.(data, evt) || []; } catch { /* sin etiquetas */ }
    this.hud ||= new EventHud(this.ctx);
    this.hud.set(this.frameBox, labels);
    this.hud.setVisible(PREFS.hud);
    this.reliefK = RELIEF[evt.type] ?? 2.5;
    this.applyFx();
    this.render(evt, data, mod);
    this.refresh(true);

    if (state !== 'cancelled') {
      state = 'refit';
      this.rig.flyTo({ ...view, duration: 2.2 }).then((ok) => { if (ok && this.token === my) this.startOrbit(); });
    }
  }

  /** Relieve exagerado y zona exterior oscurecida según las preferencias. */
  applyFx() {
    const { tiles } = this.ctx;
    this.ctx.reliefBoost = PREFS.relief ? this.reliefK : null;
    if (tiles?.focus && this.frameBox) {
      const b = this.frameBox;
      tiles.focus.box.value.set((b.w + 180) / 360, (b.s + 90) / 180, (b.e + 180) / 360, (b.n + 90) / 180);
      tiles.focus.on.value = PREFS.cine ? 1 : 0;
    }
  }

  /** Órbita lenta alrededor del evento (se para al tocar el mapa). */
  startOrbit() {
    if (!PREFS.cine || !this.evt || !this.rig.setOrbit || this.mod?.orbit === false) return;
    const b = this.frameBox;
    this.rig.setOrbit(true, latLonToVec3((b.s + b.n) / 2, (b.w + b.e) / 2, 1).normalize());
  }

  travel(evt) {
    const { start, end } = this.win;
    this.ctx.time.travel({
      start, end, speed: (end - start) / 30000, owner: 'gdacs', what: 'el evento', long: true,
      label: evt.typeLabel || TYPES[evt.type]?.label || 'Evento',
      ticks: [fmtShort.format(start), 'a mitad', fmtShort.format(end)],
    });
  }

  /** Encuadre exacto: cámara al sur del objetivo, inclinada hacia el norte, a la distancia que
   *  hace caber la caja en la parte libre de la pantalla (el panel ocupa la derecha o abajo). */
  framing(box, evt) {
    const cam = this.ctx.camera;
    const lat = THREE.MathUtils.clamp((box.s + box.n) / 2, -80, 80);
    const lon = ((((box.w + box.e) / 2) + 540) % 360) - 180;
    const cosL = Math.max(0.05, Math.cos(lat * D2R));
    const spanNS = Math.max((box.n - box.s) * D2R, 1e-4), spanEW = Math.max((box.e - box.w) * cosL * D2R, 1e-4);
    const W = innerWidth, H = innerHeight, mobile = W < 760;
    const freeW = mobile ? W : Math.max(W * 0.45, W - 420);
    const freeH = mobile ? H * 0.48 : H;
    const tv = Math.tan((cam.fov * D2R) / 2), th = tv * cam.aspect;
    const minD = MIN_DIST[evt.type] ?? 0.008;
    let v = 0.45, dist = minD; // inclinación suave: casi cenital, sin horizonte lleno de teselas lejanas
    for (let i = 0; i < 4; i++) {
      const needV = (spanNS * Math.max(Math.cos(v), 0.35)) / (2 * tv * (freeH / H) * 0.75);
      const needH = spanEW / (2 * th * (freeW / W) * 0.75);
      dist = THREE.MathUtils.clamp(Math.max(needV, needH), minD, 1.8);
      v = 0.45 - 0.3 * THREE.MathUtils.smoothstep(dist, 0.015, 0.6);
    }
    // El evento se centra en la zona libre: el centro de la vista se desplaza al este (panel a la
    // derecha) o al sur (panel abajo en móvil).
    const sx = mobile ? 0 : dist * (((W - freeW) / 2) / (W / 2)) * th;
    const sy = mobile ? (dist * (((H - freeH) / 2) / (H / 2)) * tv) / Math.max(Math.cos(v), 0.4) : 0;
    const cLat = lat - sy / D2R, cLon = lon + sx / D2R / cosL;
    const g = groundAt(this.ctx.tiles, lat, lon);
    const T = latLonToVec3(cLat, cLon, 1 + g);
    const up = T.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const P = new THREE.Vector3(), to = new THREE.Vector3();
    let tilt = 0, h = dist;
    for (let i = 0; i < 40; i++) {
      P.copy(T).addScaledVector(up, Math.cos(v) * dist).addScaledVector(north, -Math.sin(v) * dist);
      h = P.length() - 1;
      tilt = to.copy(T).sub(P).normalize().angleTo(P.clone().negate().normalize());
      if (tilt <= maxTilt(h) * 0.97 || v <= 0) break;
      v = Math.max(0, v - 0.04);
    }
    const ll = vec3ToLatLon(P);
    return { lat: ll.lat, lon: ll.lon, h, tilt, dist };
  }

  shell(evt, inner) {
    const a = { ...ALERT[evt.alert || 'None'], ...(evt.color ? { color: evt.color } : {}) };
    return `
      <div class="ev-top"><button id="ev-back" class="btn ev-back" type="button">← Volver al globo</button></div>
      <div class="pl-kicker" style="--c:${a.color}">${escapeHtml(evt.typeLabel || TYPES[evt.type]?.label || 'Evento')} · <span class="badge">${escapeHtml(a.label)}</span></div>
      <div class="pl-name">${escapeHtml(evt.name)}</div>
      <div class="pl-rest">${escapeHtml(evt.country)}</div>
      ${inner}`;
  }

  bindBack() {
    $('ev-back')?.addEventListener('click', () => this.backToGlobe());
  }

  backToGlobe() {
    const evt = this.evt;
    if (!evt) return;
    this.ctx.ui.hideDetail();
    this.rig.flyTo({ lat: evt.lat, lon: evt.lon, h: this.homeH, tilt: 0, duration: 3 });
  }

  render(evt, data, mod) {
    const now = Date.now();
    const rows = [];
    const row = (k, v) => rows.push(`<div class="pl-row"><span class="pl-k">${k}</span><span class="pl-v">${v}</span></div>`);

    const instant = evt.to - evt.from < HOUR;
    row(instant ? 'Cuándo' : 'Periodo', instant ? fmtTime(evt.from) : `${fmtTime(evt.from)}<small>hasta ${fmtTime(evt.to)}</small>`);
    let panel = { rows: [], notes: [] };
    try { panel = mod.panel(data, evt) || panel; } catch (e) { console.warn('[evento] panel', e); }
    for (const [k, v] of panel.rows) row(k, v);
    if (evt.sourceHtml) row('Fuente', evt.sourceHtml);
    else row('Fuente', `GDACS${evt.source ? ` · ${escapeHtml(evt.source)}` : ''}<small>ONU y Comisión Europea; datos del propio organismo</small>`);
    if (Number.isFinite(evt.modified)) {
      const old = now - evt.modified > 48 * HOUR;
      row('Actualizado', `${escapeHtml(timeAgo(evt.modified))}${old ? '<small class="ev-warn-txt">Datos antiguos: GDACS no lo actualiza desde hace más de 2 días</small>' : ''}`);
    }

    const series = data.failed ? [] : (() => { try { return mod.series(data, evt) || []; } catch { return []; } })();
    const chart = series.length
      ? `<div class="ev-chart-wrap"><div class="ev-chart-title">${escapeHtml(series[0].label)} <small>${escapeHtml(series[0].unit)} · línea de tiempo del evento</small></div><canvas id="ev-chart" class="ev-chart" role="img" aria-label="Gráfica de ${escapeHtml(series[0].label)}"></canvas><div class="ev-chart-note">${escapeHtml(series[0].note || 'Puntos rellenos: observado · huecos: previsión. Toca la gráfica para mover la línea de tiempo.')}</div></div>`
      : '<p class="ev-nochart">Sin serie temporal pública para este evento.</p>';

    const errs = (data.errors || []).map((e) => `<p class="ev-warn">${escapeHtml(e)}</p>`).join('');
    const retry = data.failed ? '<button id="ev-retry" class="btn" type="button">Reintentar</button>' : '';
    const notes = panel.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
    const stats = (panel.stats || []).length
      ? `<div class="ev-stats">${panel.stats.map(([v, l]) => `<div><b>${escapeHtml(v)}</b><span>${escapeHtml(l)}</span></div>`).join('')}</div>` : '';
    const labels = [...new Set(this.layers.map((l) => l.label).filter(Boolean))];
    const tog = (k, txt) => '<label class="ev-tog"><input type="checkbox" data-ev-pref="' + k + '"' + (PREFS[k] ? ' checked' : '') + '><span class="switch" aria-hidden="true"></span>' + txt + '</label>';
    const clouds = tog('cine', 'Foco cinematográfico (órbita)') + tog('relief', 'Relieve exagerado ×' + String(this.reliefK).replace('.', ',')) + tog('hud', 'Mira y etiquetas') +
      (this.env ? '<label class="ev-tog"><input type="checkbox" data-ev-env><span class="switch" aria-hidden="true"></span>Nubes (tapan el terreno)</label>' : '');
    const toggles = labels.length || clouds
      ? `<div class="ev-layers"><div class="ev-sec">Capas</div>${labels.map((l) => `<label class="ev-tog"><input type="checkbox" data-ev-layer="${escapeHtml(l)}" checked><span class="switch" aria-hidden="true"></span>${escapeHtml(l)}</label>`).join('')}${clouds}</div>` : '';
    const body = `${stats}<div class="pl-body">${rows.join('')}</div>${toggles}${errs}${chart}<ul class="ev-notes">${notes}<li>La reproducción usa la hora del evento y mueve también el sol y las nubes.</li><li>Los contornos se suavizan un poco para dibujarlos; la baliza, las ondas y las cortinas de luz son solo indicadores visuales.</li></ul>
      <div class="ev-actions">${retry}${evt.reportUrl ? `<a class="btn" href="${escapeHtml(evt.reportUrl)}" target="_blank" rel="noopener">${escapeHtml(evt.reportLabel || 'Informe GDACS')} ↗</a>` : ''}</div>`;
    $('detail-body').innerHTML = this.shell(evt, body);
    this.bindBack();
    for (const cb of document.querySelectorAll('[data-ev-layer]')) {
      cb.addEventListener('change', () => {
        if (cb.checked) this.off.delete(cb.dataset.evLayer); else this.off.add(cb.dataset.evLayer);
        this.decalKey = '';
        this.refresh(true);
      });
    }
    for (const cb of document.querySelectorAll('[data-ev-pref]')) {
      cb.addEventListener('change', () => {
        PREFS[cb.dataset.evPref] = cb.checked;
        this.applyFx();
        this.hud?.setVisible(PREFS.hud);
        if (cb.dataset.evPref === 'cine') { if (cb.checked) this.startOrbit(); else this.rig.setOrbit?.(false); }
      });
    }
    try { mod.bind?.($('detail-body'), () => { this.decalKey = ''; this.refresh(true); }); } catch { /* sin controles */ }
    countUp($('detail-body'));
    $('detail-body').querySelector('[data-ev-env]')?.addEventListener('change', (e) => {
      this.env.clouds.setVisible(e.target.checked);
      this.env.photo.setVisible(e.target.checked);
    });
    const lg = $('ev-legend');
    if (lg) {
      lg.innerHTML = '<div class="ev-sec">Leyenda</div>' + (panel.legend || []).map(([c, t]) => `<div class="ev-lg"><i style="background:${escapeHtml(c)}"></i>${escapeHtml(t)}</div>`).join('');
      lg.hidden = !(panel.legend || []).length;
    }
    $('ev-retry')?.addEventListener('click', () => this.open(evt));

    this.chart = null;
    const canvas = $('ev-chart');
    if (canvas) {
      this.chart = new EventChart(canvas, (t) => this.seek(t));
      this.chart.set(series, this.win);
    }
  }

  /** Ficha al pasar el ratón por un punto con datos propios (foco de calor, réplica…). */
  pick(x, y, radius) {
    if (!this.evt || !this.group) return null;
    const { camera, time, tiles } = this.ctx;
    const t = time.live ? Date.now() : time.now();
    const W = innerWidth, H = innerHeight;
    const v = new THREE.Vector3();
    let best = null;
    for (const l of this.layers) {
      if (!l.pick || l.visible === false || this.off.has(l.label)) continue;
      for (const it of l.pick.items) {
        if (it.t > t) continue;
        latLonToVec3(it.lat, it.lon, 1 + groundAt(tiles, it.lat, it.lon), v).project(camera);
        if (v.z > 1) continue;
        const d = Math.hypot((v.x + 1) / 2 * W - x, (1 - v.y) / 2 * H - y);
        if (d <= radius + 6 && (!best || d < best.d)) best = { d, it, l };
      }
    }
    return best ? { dist: best.d - 3, html: best.l.pick.html(best.it, t) } : null;
  }

  seek(t) {
    const { time } = this.ctx;
    if (time.span !== 'event' || time.event?.owner !== 'gdacs') return;
    const { start, end } = this.win;
    time.seek(THREE.MathUtils.clamp((t - start) / (end - start), 0, 1));
  }

  /** Hora simulada → visibilidad de las capas y cursor de la gráfica (≈10 veces por segundo). */
  refresh(force = false) {
    const now = performance.now();
    if (!force && now - this.lastUpdate < 100) return;
    this.lastUpdate = now;
    const { time } = this.ctx;
    const t = time.live ? Date.now() : time.now();
    for (const l of this.layers) {
      l.update?.(t);
      if (this.off.has(l.label)) { l.visible = false; if (l.object) l.object.visible = false; }
    }
    if (this.decalMode) {
      const on = this.layers.filter((l) => l.decal && l.visible && (!this.forced || l.decal.always));
      const key = on.map((l) => this.layers.indexOf(l) + ':' + (l.decal.stamp?.(t) ?? '')).join(',');
      if (key !== this.decalKey) {
        this.decalKey = key;
        this.decalCanvas ||= document.createElement('canvas');
        paintDecal(this.decalCanvas, this.decalBox, on, t, this.decalRes);
        this.ctx.tiles.setDecal(this.decalCanvas, this.decalBox, true);
      }
    }
    if (this.beacon) {
      let f = null, on = true;
      try { f = this.mod.focus?.(this.data, this.evt, t) || null; } catch { /* centroide */ }
      if (f && (f.lat !== this.bLat || f.lon !== this.bLon)) { this.bLat = f.lat; this.bLon = f.lon; this.beacon.userData.place(f.lat, f.lon); }
      try { on = this.mod.pulse ? this.mod.pulse(this.data, this.evt, t) : true; } catch { /* siempre */ }
      this.beacon.userData.setRings(on && this.mod.rings !== false);
    }
    this.chart?.setCursor(t);
  }

  update() {
    if (!this.evt || !this.group) return;
    const now = performance.now();
    fxClock.value = now / 1000;
    const r = this.ctx.renderer, cam = this.ctx.camera;
    const db = r.getDrawingBufferSize(new THREE.Vector2());
    setLineResolution(db.x / r.getPixelRatio(), db.y / r.getPixelRatio());
    const scale = db.y / (2 * Math.tan((cam.fov * D2R) / 2));
    for (const l of this.layers) l.object?.userData.setScale?.(scale);
    // La baliza se encoge al acercarse: nunca tapa la pantalla
    if (this.beacon) this.beacon.scale.setScalar(THREE.MathUtils.clamp(cam.position.distanceTo(this.beacon.position) / (this.beaconSize * 1.2), 0.04, 1));
    // Las alturas del terreno llegan poco a poco: se re-asientan los objetos durante el primer minuto
    const ex = this.ctx.tiles?.exag.value ?? 0;
    if ((now - this.openedAt < 60000 && now - this.lastGround > 1000) || Math.abs(ex - (this.lastExag ?? ex)) > 0.02) {
      this.lastGround = now;
      this.lastExag = ex;
      this.group.traverse((o) => o.userData.reground?.());
    }
    this.refresh();
  }

  /** Tras colocar la cámara (incluida la órbita): mira y etiquetas del HUD. */
  afterCamera() {
    if (!this.evt || !this.group) return;
    const { time } = this.ctx;
    this.hud?.update(time.live ? Date.now() : time.now());
  }

  teardown() {
    if (this.group) { this.ctx.scene.remove(this.group); disposeTree(this.group); }
    this.group = null;
    this.layers = [];
    this.chart = null;
    this.decalMode = false;
    this.ctx.tiles?.setDecal(null);
    this.ctx.reliefBoost = null;
    if (this.ctx.tiles?.focus) this.ctx.tiles.focus.on.value = 0;
    this.rig.setOrbit?.(false);
    this.hud?.hide();
    this.forced = false;
    this.ctx.fogScale = 1;
    if (this.ctx.tiles) this.ctx.tiles.lift.value = 0;
    if (this.envSaved) {
      this.env.clouds.setVisible(this.envSaved.clouds);
      this.env.photo.setVisible(this.envSaved.photo);
      this.envSaved = null;
    }
    document.body.classList.remove('event-mode');
    const lg = $('ev-legend');
    if (lg) lg.hidden = true;
    if (!this.evt) return;
    this.evt = null;
    this.layer.focus(null);
    const { time } = this.ctx;
    if (time.span === 'event' && time.event?.owner === 'gdacs') time.goLive();
  }
}
