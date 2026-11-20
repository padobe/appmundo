// Tour cinematográfico: recorre lo más interesante del momento con textos breves.
// Cualquier interacción del usuario lo detiene.
import { latLonToVec3, vec3ToLatLon } from './geo.js';
import { subsolarPoint } from './sun.js';
import { describePlace } from './regions.js';
import { timeAgo } from './net.js';

const $ = (id) => document.getElementById(id);
const wait = (ms, token) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  token.cancel = () => { clearTimeout(t); rej(new Error('cancel')); };
});

const MOUNTAINS = [
  { name: 'el Everest', lat: 27.99, lon: 86.93 },
  { name: 'el Mont Blanc', lat: 45.83, lon: 6.86 },
  { name: 'el Aconcagua', lat: -32.65, lon: -70.01 },
  { name: 'el Kilimanjaro', lat: -3.07, lon: 37.35 },
  { name: 'el monte Fuji', lat: 35.36, lon: 138.73 },
  { name: 'el Gran Cañón', lat: 36.1, lon: -112.11 },
  { name: 'el Teide', lat: 28.27, lon: -16.64 },
  { name: 'el Denali', lat: 63.07, lon: -151.0 },
];

export class Tour {
  constructor(ctx, { rig, layers, setFollow }) {
    this.ctx = ctx;
    this.rig = rig;
    this.layers = layers;
    this.setFollow = setFollow;
    this.running = false;
    this.token = {};
    $('tour-exit').addEventListener('click', () => this.stop());
  }

  sunElevAt(lat, lon) {
    const up = latLonToVec3(lat, lon, 1);
    return (Math.asin(up.dot(this.ctx.earth.uniforms.sunDir.value)) * 180) / Math.PI;
  }

  buildStops() {
    const stops = [];
    const sun = subsolarPoint(new Date());
    stops.push({
      kicker: 'Planeta en vivo', title: 'La Tierra, ahora mismo',
      text: 'La línea entre el día y la noche está exactamente donde está ahora.',
      lat: 18, lon: sun.lon - 75, h: 2.4, tilt: 0, hold: 5500,
    });

    // Amanecer: 90° al oeste del punto subsolar
    const dawnLon = ((sun.lon - 90 + 540) % 360) - 180;
    const dawnLat = Math.max(-50, Math.min(50, -sun.lat * 0.5 + 15));
    stops.push({
      kicker: 'Amanecer', title: `Ahora amanece sobre ${describePlace(dawnLat, dawnLon, this.ctx.earth.isWater(dawnLat, dawnLon)).name}`,
      text: 'El terminador avanza unos 1.670 km/h en el ecuador.',
      lat: dawnLat, lon: dawnLon, h: 0.35, tilt: 0.5, hold: 5500,
    });

    const q = this.layers.quakes?.all?.reduce((m, x) => (!m || x.mag > m.mag ? x : m), null);
    if (q) {
      stops.push({
        kicker: 'Terremoto más fuerte del día', title: `M ${q.mag.toFixed(1)} · ${q.place || ''}`,
        text: `Ocurrió ${timeAgo(q.time)} a ${Math.round(q.depth ?? 0)} km de profundidad.`,
        lat: q.lat, lon: q.lon, h: 0.5, tilt: 0, hold: 5500,
      });
    }

    const aur = this.layers.aurora?.strongestAtNight((la, lo) => this.sunElevAt(la, lo) < -8);
    if (aur) {
      stops.push({
        kicker: 'Aurora', title: `Probabilidad de aurora del ${Math.round(aur.v)} %`,
        text: 'Previsión de NOAA para la próxima media hora sobre la cara nocturna.',
        lat: aur.lat, lon: aur.lon, h: 0.7, tilt: 0.3, hold: 5500,
      });
    }

    const ev = (this.layers.eonet?.items || []).find((i) => i.catId === 'severeStorms')
      || (this.layers.eonet?.items || []).find((i) => i.catId === 'volcanoes');
    if (ev) {
      stops.push({
        kicker: `${ev.cat.label} activo · NASA`, title: ev.ev.title,
        text: `Último dato ${timeAgo(new Date(ev.date).getTime())}.`,
        lat: ev.lat, lon: ev.lon, h: 0.4, tilt: 0, hold: 5000,
      });
    }

    if (this.layers.iss?.state) {
      const { lat, lon } = vec3ToLatLon(this.layers.iss.sub);
      stops.push({
        kicker: 'Estación Espacial Internacional', title: `A ${Math.round(this.layers.iss.state.alt)} km de altura`,
        text: `Da una vuelta a la Tierra cada 92 minutos, a ${Math.round(this.layers.iss.state.vel).toLocaleString('es-ES')} km/h.`,
        lat, lon, h: 0.45, tilt: 0, hold: 7000, follow: true,
      });
    }

    const lit = MOUNTAINS.filter((m) => this.sunElevAt(m.lat, m.lon) > 12);
    const m = lit[Math.floor(Math.random() * lit.length)];
    if (m) {
      stops.push({
        kicker: 'Relieve 3D', title: `Sobrevolando ${m.name}`,
        text: 'Imágenes de satélite y relieve real, con la luz del sol de este momento.',
        lat: m.lat - 0.06, lon: m.lon, h: 0.0011, tilt: 1.1, hold: 8000, orbit: true,
      });
    }

    stops.push({
      kicker: 'Fin del tour', title: 'Ahora explora tú',
      text: 'Arrastra para girar, rueda o pellizco para acercarte y clic derecho para inclinar la vista.',
      lat: 25, lon: -new Date().getTimezoneOffset() / 4, h: 2.6, tilt: 0, hold: 4500,
    });
    return stops;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.token = {};
    document.body.classList.add('touring');
    const stops = this.buildStops();
    this.renderDots(stops.length);
    try {
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        this.caption(s, i);
        this.setFollow(false);
        const arrived = await this.rig.flyTo({ lat: s.lat, lon: s.lon, h: s.h, tilt: s.tilt, duration: 4.2 });
        if (!arrived || !this.running) throw new Error('cancel');
        if (s.follow) this.setFollow(true);
        if (s.orbit) this.rig.drift(0.012);
        await wait(s.hold, this.token);
        this.rig.drift(0);
      }
    } catch { /* cancelado */ }
    this.finish();
  }

  stop() {
    if (!this.running) return;
    this.token.cancel?.();
    this.rig.cancel();
    this.finish();
  }

  finish() {
    this.running = false;
    this.rig.drift(0);
    this.setFollow(false);
    document.body.classList.remove('touring');
  }

  renderDots(n) {
    $('tour-dots').innerHTML = Array.from({ length: n }, () => '<span></span>').join('');
  }

  caption(s, i) {
    const box = $('tour-caption');
    box.classList.remove('show');
    setTimeout(() => {
      $('tour-kicker').textContent = s.kicker;
      $('tour-title').textContent = s.title;
      $('tour-text').textContent = s.text;
      [...$('tour-dots').children].forEach((d, k) => d.classList.toggle('on', k <= i));
      box.classList.add('show');
    }, 350);
  }
}
