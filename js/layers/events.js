// Capa: índice de eventos GDACS (terremotos, ciclones, inundaciones, incendios, volcanes)
// con su nivel de alerta. Al pulsar uno se abre la vista detallada (js/events/view.js).
import * as THREE from 'three';
import { latLonToVec3, toScreen, isOccluded } from '../geo.js';
import { escapeHtml, timeAgo } from '../net.js';
import { icon } from './eonet.js';
import { loadEventList, TYPES, ALERT } from '../events/gdacs.js';

const REFRESH_MS = 15 * 60 * 1000;
const RANK = { Green: 0, Orange: 1, Red: 2 };

export class GdacsLayer {
  id = 'gdacs';
  name = 'GDACS';

  constructor(ctx, { open }) {
    this.ctx = ctx;
    this.open = open;
    this.visible = true;
    this.focusKey = null;
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
    this.textures = {};
    this.items = [];
  }

  start() {
    this.refresh();
    setInterval(() => { if (!document.hidden) this.refresh(); }, REFRESH_MS);
  }

  async refresh() {
    try {
      this.build(await loadEventList());
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[gdacs]', e);
      this.ctx.ui.sourceError(this.id, 'GDACS no responde · reintentando');
    }
  }

  build(events) {
    for (const o of [...this.group.children]) { this.group.remove(o); o.material.dispose(); }
    const max = this.ctx.isMobile ? 80 : 200;
    this.items = [];
    const sorted = [...events].sort((a, b) => RANK[b.alert] - RANK[a.alert] || b.from - a.from).slice(0, max);
    for (const evt of sorted) {
      const a = ALERT[evt.alert];
      const k = `${evt.type}|${evt.alert}`;
      const tex = this.textures[k] || (this.textures[k] = icon({ color: a.color, glyph: TYPES[evt.type].glyph }));
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }));
      const pos = latLonToVec3(evt.lat, evt.lon, 1.007);
      s.position.copy(pos);
      s.scale.setScalar(a.size);
      s.renderOrder = 6 + RANK[evt.alert];
      this.group.add(s);
      this.items.push({ evt, pos, sprite: s });
    }
  }

  setVisible(on) { this.visible = on; }

  /** Con una vista de evento abierta, la capa se oculta (la vista dibuja su propia geometría). */
  focus(key) { this.focusKey = key; }

  update() {
    this.group.visible = this.visible && this.ctx.time.live && !this.focusKey;
    if (!this.group.visible) return;
    const cam = this.ctx.camera.position;
    const n = new THREE.Vector3(), v = new THREE.Vector3();
    for (const it of this.items) {
      n.copy(it.pos).normalize();
      v.copy(cam).sub(it.pos).normalize();
      const f = THREE.MathUtils.smoothstep(n.dot(v), -0.02, 0.1);
      it.sprite.material.opacity = f;
      it.sprite.visible = f > 0.01;
    }
  }

  pick(x, y, radius) {
    if (!this.group.visible) return null;
    const { camera, size } = this.ctx;
    const { w, h } = size();
    let best = null;
    for (const it of this.items) {
      const sp = toScreen(it.pos, camera, w, h);
      if (sp.behind) continue;
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > radius + 8 || (best && d >= best.dist)) continue;
      if (isOccluded(it.pos, camera.position)) continue;
      best = { dist: d, it };
    }
    if (!best) return null;
    const { evt } = best.it;
    const a = ALERT[evt.alert];
    const sev = evt.severity?.severitytext && Number(evt.severity.severity) > 0 ? ` · ${escapeHtml(evt.severity.severitytext)}` : '';
    return {
      dist: best.dist - 2, // a igual distancia gana la alerta GDACS sobre el marcador genérico
      select: () => this.open(evt),
      html: `
        <div class="tt-kicker" style="--c:${a.color}"><span class="tt-dot"></span>${escapeHtml(TYPES[evt.type].label)} · ${escapeHtml(a.label)}</div>
        <div class="tt-title">${escapeHtml(evt.name)}</div>
        <div class="tt-meta">${escapeHtml(evt.country)}${evt.country ? ' · ' : ''}${escapeHtml(timeAgo(evt.modified || evt.from))}${sev}</div>
        <div class="tt-hint">Clic para ver el evento en detalle</div>`,
    };
  }
}
