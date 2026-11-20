// Vista detallada común: vuelo de cámara al terreno, panel con datos y fuente, línea de tiempo
// del evento y gráfica. Cada fenómeno aporta un módulo (ver modules.js); esto no sabe de tipos.
// Se carga con import() la primera vez que se abre un evento.
import * as THREE from 'three';
import { escapeHtml, timeAgo } from '../net.js';
import { TYPES, ALERT } from './gdacs.js';
import { getModule } from './modules.js';
import { EventChart } from './chart.js';
import { disposeTree, decalBox, paintDecal } from './draw.js';

const HOUR = 3600000;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const fmtShort = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtTime = (ms) => `${fmt.format(ms)} UTC`;
const DEFAULT_H = { EQ: 0.03, TC: 0.45, FL: 0.12, WF: 0.04, VO: 0.02, DR: 0.3 };

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
  constructor(ctx, { rig, homeH, layer }) {
    this.ctx = ctx;
    this.rig = rig;
    this.homeH = homeH;
    this.layer = layer;
    this.token = 0;
    this.evt = null;
    this.group = null;
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
    this.ctx.fogScale = 0.25; // menos bruma: la imagen se ve nítida y con relieve

    this.travel(evt);

    // Vuelo provisional mientras llegan los datos; se afina con el encuadre real
    let state = 'flying';
    const h0 = DEFAULT_H[evt.type] ?? 0.1;
    this.rig.flyTo({ ...this.aim(evt.lat, evt.lon, h0), duration: 3 })
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

    this.group = new THREE.Group();
    try {
      this.layers = mod.layers(data, evt) || [];
    } catch (e) {
      console.warn('[evento] capas', e);
      data.errors = [...(data.errors || []), 'No se pudo dibujar la geometría del evento.'];
    }
    let box = null;
    try { box = mod.frame?.(data, evt) || null; } catch { /* encuadre por defecto */ }

    // Zonas pequeñas: se pintan sobre las teselas (siguen el relieve). Zonas grandes: líneas 3D.
    const dl = this.layers.filter((l) => l.decal);
    const dbox = dl.length ? decalBox(dl) : null;
    const span = dbox ? Math.max(dbox.n - dbox.s, (dbox.e - dbox.w) * Math.cos(((dbox.n + dbox.s) / 2) * Math.PI / 180)) : 99;
    this.decalMode = !!dbox && span <= 6 && !!this.ctx.tiles;
    this.decalBox = this.decalMode ? dbox : null;
    this.decalKey = '';
    this.off = new Set();
    for (const l of this.layers) if (!(this.decalMode && l.decal)) this.group.add(l.object);
    this.ctx.scene.add(this.group);
    this.render(evt, data, mod);
    this.refresh(true);

    if (state !== 'cancelled') {
      const view = this.framing(box, evt);
      state = 'refit';
      this.rig.flyTo({ ...view, duration: 2.5 });
    }
  }

  travel(evt) {
    const { start, end } = this.win;
    this.ctx.time.travel({
      start, end, speed: (end - start) / 30000, owner: 'gdacs', what: 'el evento', long: true,
      label: TYPES[evt.type]?.label || 'Evento',
      ticks: [fmtShort.format(start), 'a mitad', fmtShort.format(end)],
    });
  }

  tiltFor(h) { return 1.05 * (1 - THREE.MathUtils.smoothstep(h, 0.03, 0.22)); }

  framing(box, evt) {
    if (!box) { const h = DEFAULT_H[evt.type] ?? 0.1; return this.aim(evt.lat, evt.lon, h); }
    const lat = (box.s + box.n) / 2;
    let lon = (box.w + box.e) / 2;
    lon = ((lon + 540) % 360) - 180;
    const span = Math.max(box.n - box.s, (box.e - box.w) * Math.cos((lat * Math.PI) / 180));
    const floor = (DEFAULT_H[evt.type] ?? 0.1) * 0.5;
    const h = THREE.MathUtils.clamp(((span * Math.PI) / 180) * 2.6, floor, 0.9);
    return this.aim(lat, lon, h);
  }

  /** Con la cámara inclinada la vista apunta por delante del punto bajo ella: se retrasa hacia el sur para centrar el evento. */
  aim(lat, lon, h) {
    const tilt = this.tiltFor(h);
    const back = Math.min(((h * Math.tan(tilt)) * 180) / Math.PI, 40);
    return { lat: THREE.MathUtils.clamp(lat - back, -85, 85), lon, h, tilt };
  }

  shell(evt, inner) {
    const a = ALERT[evt.alert];
    return `
      <div class="ev-top"><button id="ev-back" class="btn ev-back" type="button">← Volver al globo</button></div>
      <div class="pl-kicker" style="--c:${a.color}">${escapeHtml(TYPES[evt.type]?.label || 'Evento')} · <span class="badge">${escapeHtml(a.label)}</span></div>
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
    row('Fuente', `GDACS${evt.source ? ` · ${escapeHtml(evt.source)}` : ''}<small>ONU y Comisión Europea; datos del propio organismo</small>`);
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
    const toggles = labels.length
      ? `<div class="ev-layers"><div class="ev-sec">Capas</div>${labels.map((l) => `<label class="ev-tog"><input type="checkbox" data-ev-layer="${escapeHtml(l)}" checked><span class="switch" aria-hidden="true"></span>${escapeHtml(l)}</label>`).join('')}</div>` : '';
    const body = `${stats}<div class="pl-body">${rows.join('')}</div>${toggles}${errs}${chart}<ul class="ev-notes">${notes}<li>La reproducción usa la hora del evento y mueve también el sol y las nubes.</li></ul>
      <div class="ev-actions">${retry}${evt.reportUrl ? `<a class="btn" href="${escapeHtml(evt.reportUrl)}" target="_blank" rel="noopener">Informe GDACS ↗</a>` : ''}</div>`;
    $('detail-body').innerHTML = this.shell(evt, body);
    this.bindBack();
    for (const cb of document.querySelectorAll('[data-ev-layer]')) {
      cb.addEventListener('change', () => {
        if (cb.checked) this.off.delete(cb.dataset.evLayer); else this.off.add(cb.dataset.evLayer);
        this.decalKey = '';
        this.refresh(true);
      });
    }
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
      const on = this.layers.filter((l) => l.decal && l.visible);
      const key = on.map((l) => this.layers.indexOf(l) + ':' + (l.decal.stamp?.(t) ?? '')).join(',');
      if (key !== this.decalKey) {
        this.decalKey = key;
        this.decalCanvas ||= document.createElement('canvas');
        paintDecal(this.decalCanvas, this.decalBox, on, t);
        this.ctx.tiles.setDecal(this.decalCanvas, this.decalBox, true);
      }
    }
    this.chart?.setCursor(t);
  }

  update() {
    if (this.evt && this.group) this.refresh();
  }

  teardown() {
    if (this.group) { this.ctx.scene.remove(this.group); disposeTree(this.group); }
    this.group = null;
    this.layers = [];
    this.chart = null;
    this.decalMode = false;
    this.ctx.tiles?.setDecal(null);
    this.ctx.fogScale = 1;
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
