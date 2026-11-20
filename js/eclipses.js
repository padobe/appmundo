// Eclipses: lista de los próximos (calculados en el navegador con astronomy-engine),
// viaje en el tiempo al momento del eclipse, línea central de la sombra de la Luna
// sobre la Tierra y un visor de la Luna para los eclipses lunares.
import * as THREE from 'three';
import * as ephem from './ephemeris.js';
import { describePlace } from './regions.js';
import { escapeHtml } from './net.js';

const WINDOW_H = 3; // horas antes y después del máximo
const SPEED = 600; // 6 h en ~36 s

export class Eclipses {
  constructor(ctx, { rig, sky }) {
    this.ctx = ctx;
    this.rig = rig;
    this.sky = sky;
    this.list = null;
    this.active = null;
    this.path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
      color: 0xd9b3ff, dashSize: 0.01, gapSize: 0.006, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    this.path.renderOrder = 6;
    this.path.visible = false;
    ctx.scene.add(this.path);
    // Cámara del visor lunar: solo ve la capa 2 (la Luna)
    this.moonCam = new THREE.PerspectiveCamera(8, 1, 0.05, 10);
    this.moonCam.layers.set(2);
  }

  async open() {
    const { ui } = this.ctx;
    ui.showDetail('<div class="pl-kicker">Eclipses</div><div class="pl-name">Calculando…</div>');
    try {
      await ephem.loadAstronomy();
      this.list = ephem.upcomingEclipses(new Date(), 3);
    } catch {
      ui.showDetail('<div class="pl-kicker">Eclipses</div><div class="pl-name">No se pudo cargar el cálculo astronómico</div>');
      return;
    }
    const fmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    const rows = this.list.map((e, i) => {
      const where = e.type === 'solar' ? `Máximo sobre ${describePlace(e.lat, e.lon, this.ctx.earth.isWater(e.lat, e.lon)).name}` : 'Visible desde la cara nocturna de la Tierra';
      const days = Math.round((e.peak - Date.now()) / 86400000);
      return `
        <div class="ec-row">
          <div class="ec-icon ${e.type}" aria-hidden="true"></div>
          <div class="ec-text">
            <div class="ec-title">Eclipse ${e.type === 'solar' ? 'solar' : 'lunar'} ${escapeHtml(e.kindEs)}</div>
            <div class="ec-meta">${escapeHtml(fmt.format(e.peak))} · dentro de ${days} días<br>${escapeHtml(where)}</div>
          </div>
          <button class="btn ec-go" type="button" data-ec="${i}">Ver</button>
        </div>`;
    }).join('');
    ui.showDetail(`
      <div class="pl-kicker">Próximos eclipses</div>
      <div class="pl-name">Viaja al momento exacto</div>
      <div class="ec-list">${rows}</div>
      <p class="ec-note">Posiciones calculadas en tu navegador. La sombra de la Luna se dibuja sobre el planeta y la línea discontinua marca su recorrido central.</p>`);
    for (const b of document.querySelectorAll('[data-ec]')) {
      b.addEventListener('click', () => this.view(this.list[Number(b.dataset.ec)]));
    }
  }

  view(e) {
    const { time, ui } = this.ctx;
    ui.hideDetail();
    this.active = e;
    const start = e.peak.getTime() - WINDOW_H * 3600000;
    const end = e.peak.getTime() + WINDOW_H * 3600000;
    const label = `Eclipse ${e.type === 'solar' ? 'solar' : 'lunar'} ${e.kindEs} · ${e.peak.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    time.travel({ start, end, label, speed: SPEED });
    if (e.type === 'solar') {
      const pts = ephem.eclipsePath(e.peak, WINDOW_H, 2).map((p) => p.multiplyScalar(1.003));
      this.path.geometry.dispose();
      this.path.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.path.computeLineDistances();
      this.path.visible = pts.length > 1;
      this.rig.flyTo({ lat: e.lat, lon: e.lon, h: 1.5, tilt: 0, duration: 3 });
      ui.toast('La sombra de la Luna recorrerá la Tierra: dale al play si está en pausa', 'info', 'eclipse');
    } else {
      this.path.visible = false;
      // La cámara mira a la cara de la Tierra que da a la Luna; el visor muestra la Luna
      const m = this.ctx.earth.uniforms.uMoonPos.value.clone().normalize();
      const lat = (Math.asin(m.y) * 180) / Math.PI;
      const lon = ((Math.atan2(m.z, -m.x) * 180) / Math.PI - 180 + 540) % 360 - 180;
      this.rig.flyTo({ lat, lon, h: 2.4, tilt: 0, duration: 3 });
      ui.toast('Mira el visor de la Luna: la sombra de la Tierra la irá tiñendo de rojo', 'info', 'eclipse');
    }
  }

  get lunarActive() {
    return this.active?.type === 'lunar' && this.ctx.time.span === 'event';
  }

  update() {
    if (this.active && this.ctx.time.span !== 'event') {
      this.active = null;
      this.path.visible = false;
    }
    this.sky.forceMoon = this.lunarActive;
    document.body.classList.toggle('moon-view', this.lunarActive);
  }

  /** Dibuja el visor de la Luna en una esquina (eclipses lunares). */
  renderInset(renderer) {
    if (!this.lunarActive) return;
    const el = document.getElementById('moon-inset');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const moon = this.sky.moon;
    const dir = moon.position.clone().normalize();
    this.moonCam.position.copy(moon.position).addScaledVector(dir, -2.8);
    this.moonCam.lookAt(moon.position);
    this.moonCam.aspect = r.width / r.height;
    this.moonCam.updateProjectionMatrix();
    const y = innerHeight - r.bottom;
    renderer.setScissorTest(true);
    renderer.setScissor(r.left, y, r.width, r.height);
    renderer.setViewport(r.left, y, r.width, r.height);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(this.ctx.scene, this.moonCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
  }
}
