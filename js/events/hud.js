// HUD de la vista de eventos: mira con corchetes que enmarca la zona, lectura de coordenadas
// y altitud en vivo, barrido de escaneo al abrir, cifras que cuentan y etiquetas ancladas al relieve.
import * as THREE from 'three';
import { latLonToVec3, vec3ToLatLon, isOccluded } from '../geo.js';
import { escapeHtml } from '../net.js';
import { groundAt } from './fx.js';

const v = new THREE.Vector3();

export class EventHud {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = document.createElement('div');
    this.root.className = 'ev-hud';
    this.root.innerHTML = `
      <div class="ev-scan"></div>
      <div class="ev-frame"><i></i><i></i><i></i><i></i>
        <div class="ev-read"><b class="ev-tag">OBJETIVO</b><span data-k="ll"></span><span data-k="alt"></span></div>
      </div>
      <div class="ev-labels"></div>`;
    document.body.appendChild(this.root);
    this.frame = this.root.querySelector('.ev-frame');
    this.ll = this.root.querySelector('[data-k="ll"]');
    this.alt = this.root.querySelector('[data-k="alt"]');
    this.labelsEl = this.root.querySelector('.ev-labels');
    this.labels = [];
    this.box = null;
    this.on = true;
    this.cur = null;
  }

  /** box: { w, e, s, n } en grados; labels: [{ lat, lon, text, sub?, t?, kind? }] */
  set(box, labels = []) {
    this.box = box;
    this.cur = null;
    this.labelsEl.innerHTML = '';
    this.labels = labels.slice(0, 40).map((l) => {
      const el = document.createElement('div');
      el.className = `ev-lab ${l.kind || ''}`;
      el.innerHTML = `<span>${escapeHtml(l.text)}</span>${l.sub ? `<small>${escapeHtml(l.sub)}</small>` : ''}`;
      this.labelsEl.appendChild(el);
      return { ...l, el };
    });
    this.root.classList.remove('scan');
    void this.root.offsetWidth; // reinicia la animación de barrido
    this.root.classList.add('scan', 'show');
  }

  setVisible(on) { this.on = on; this.root.classList.toggle('off', !on); }

  hide() { this.root.classList.remove('show', 'scan'); this.labelsEl.innerHTML = ''; this.labels = []; this.box = null; }

  update(t) {
    if (!this.box || !this.on) return;
    const { camera, tiles } = this.ctx;
    const W = innerWidth, H = innerHeight;
    camera.updateMatrixWorld();
    const proj = (lat, lon, lift = 0) => {
      latLonToVec3(lat, lon, 1 + groundAt(tiles, lat, lon) + lift, v);
      const occ = isOccluded(v, camera.position);
      v.project(camera);
      return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, ok: v.z < 1 && !occ };
    };
    // Mira: rectángulo en pantalla que envuelve la zona (suavizado para que no tiemble)
    const b = this.box;
    const pts = [[b.s, b.w], [b.s, b.e], [b.n, b.w], [b.n, b.e], [(b.s + b.n) / 2, b.w], [(b.s + b.n) / 2, b.e], [b.s, (b.w + b.e) / 2], [b.n, (b.w + b.e) / 2]].map(([la, lo]) => proj(la, lo)).filter((p) => p.ok);
    if (pts.length >= 2) {
      const pad = 18;
      let x0 = Math.min(...pts.map((p) => p.x)) - pad, x1 = Math.max(...pts.map((p) => p.x)) + pad;
      let y0 = Math.min(...pts.map((p) => p.y)) - pad, y1 = Math.max(...pts.map((p) => p.y)) + pad;
      const right = W < 760 ? W - 12 : W - 400; // sin meterse bajo el panel
      const bottom = W < 760 ? H * 0.5 : H - 110;
      x0 = Math.max(24, x0); y0 = Math.max(150, y0); x1 = Math.min(right, x1); y1 = Math.min(bottom, y1);
      const tgt = [x0, y0, Math.max(60, x1 - x0), Math.max(60, y1 - y0)];
      this.cur = this.cur ? this.cur.map((c, i) => c + (tgt[i] - c) * 0.18) : tgt;
      const [x, y, w, h] = this.cur;
      this.frame.style.transform = `translate(${x}px, ${y}px)`;
      this.frame.style.width = `${w}px`;
      this.frame.style.height = `${h}px`;
      this.frame.style.opacity = '1';
    } else this.frame.style.opacity = '0';
    // Lectura en vivo: punto bajo el centro de la mira y altitud de la cámara
    const c = vec3ToLatLon(camera.position);
    const hKm = (camera.position.length() - 1) * 6371;
    const lat = (b.s + b.n) / 2, lon = (b.w + b.e) / 2;
    this.ll.textContent = `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'O'}`;
    this.alt.textContent = `CÁMARA ${hKm < 100 ? hKm.toFixed(1).replace(".", ",") : Math.round(hKm).toLocaleString("es-ES")} km`;
    // Etiquetas ancladas al relieve
    for (const l of this.labels) {
      const p = proj(l.lat, l.lon, 0.00002);
      const show = p.ok && (l.t == null || t >= l.t) && p.x > 0 && p.x < W && p.y > 0 && p.y < H;
      l.el.style.opacity = show ? '1' : '0';
      if (show) l.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
  }

  dispose() { this.root.remove(); }
}

/** Las cifras grandes del panel cuentan desde cero al aparecer. */
export function countUp(root) {
  for (const b of root.querySelectorAll('.ev-stats b')) {
    const txt = b.textContent.trim();
    const m = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?(.*)$/.exec(txt);
    if (!m || txt.includes(':')) continue;
    const dec = m[2] ? m[2].length : 0;
    const val = Number(m[1].replace(/\./g, '') + (dec ? '.' + m[2] : ''));
    if (!Number.isFinite(val) || val === 0) continue;
    const t0 = performance.now(), dur = 1100;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
      b.textContent = (val * e).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + m[3];
      if (k < 1) requestAnimationFrame(step); else b.textContent = txt;
    };
    requestAnimationFrame(step);
  }
}
