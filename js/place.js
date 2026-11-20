// "Desde aquí": el usuario escribe una calle, ciudad o zona (sin geolocalización)
// y ve qué pasa sobre ese punto: hora local, sol, luna, tiempo, auroras,
// fenómenos cercanos y próximos pasos visibles de la ISS.
// Búsqueda: Photon (komoot, datos de OpenStreetMap), sin clave; solo al pulsar Intro.
import * as THREE from 'three';
import { latLonToVec3 } from './geo.js';
import { sunTimes, moonPhase } from './astro.js';
import { fetchJSON, escapeHtml } from './net.js';

const $ = (id) => document.getElementById(id);
const SEARCH = (q) => `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
const WEATHER = (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
  + '&current=temperature_2m,weather_code,wind_speed_10m,cloud_cover,is_day&timezone=auto';

const WMO = {
  0: 'Despejado', 1: 'Casi despejado', 2: 'Parcialmente nublado', 3: 'Nublado', 45: 'Niebla', 48: 'Niebla con escarcha',
  51: 'Llovizna débil', 53: 'Llovizna', 55: 'Llovizna intensa', 56: 'Llovizna helada', 57: 'Llovizna helada',
  61: 'Lluvia débil', 63: 'Lluvia', 65: 'Lluvia fuerte', 66: 'Lluvia helada', 67: 'Lluvia helada fuerte',
  71: 'Nieve débil', 73: 'Nieve', 75: 'Nieve fuerte', 77: 'Granizo fino', 80: 'Chubascos', 81: 'Chubascos', 82: 'Chubascos fuertes',
  85: 'Chubascos de nieve', 86: 'Chubascos de nieve', 95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo',
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function label(f) {
  const p = f.properties;
  const main = p.name || p.street || p.city || '';
  const rest = [p.street && p.name !== p.street ? p.street : null, p.city !== main ? p.city : null, p.state, p.country]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  return { main, rest: rest.join(', ') };
}

function pinTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffb547'; g.lineWidth = 4;
  g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#fff3df';
  g.beginPath(); g.arc(32, 32, 7, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PlacePanel {
  constructor(ctx, { rig, layers }) {
    this.ctx = ctx;
    this.rig = rig;
    this.layers = layers; // { quakes, eonet, aurora, sats }
    this.place = null;
    this.pin = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTexture(), transparent: true, depthWrite: false, sizeAttenuation: false }));
    this.pin.scale.setScalar(0.035);
    this.pin.renderOrder = 6;
    this.pin.visible = false;
    ctx.scene.add(this.pin);
    this.bind();
  }

  bind() {
    const form = $('search-form'), input = $('search-input'), list = $('search-results');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q.length < 2) return;
      list.innerHTML = '<li class="sr-msg">Buscando…</li>';
      list.hidden = false;
      try {
        const d = await fetchJSON(SEARCH(q), { timeout: 10000 });
        const feats = (d.features || []).filter((f) => f.geometry?.coordinates);
        if (!feats.length) { list.innerHTML = '<li class="sr-msg">Sin resultados. Prueba con otra forma de escribirlo.</li>'; return; }
        list.innerHTML = '';
        for (const f of feats) {
          const { main, rest } = label(f);
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.innerHTML = `<span class="sr-main">${escapeHtml(main)}</span><span class="sr-rest">${escapeHtml(rest)}</span>`;
          btn.addEventListener('click', () => {
            list.hidden = true;
            const [lon, lat] = f.geometry.coordinates;
            this.select({ lat, lon, name: main, rest });
          });
          li.appendChild(btn);
          list.appendChild(li);
        }
      } catch {
        list.innerHTML = '<li class="sr-msg">El buscador no responde ahora mismo.</li>';
      }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { list.hidden = true; input.blur(); } });
    document.addEventListener('pointerdown', (e) => { if (!form.contains(e.target)) list.hidden = true; });
    $('place-close').addEventListener('click', () => this.close());
    $('place-3d').addEventListener('click', () => {
      if (this.place) this.rig.flyTo({ lat: this.place.lat, lon: this.place.lon, h: 0.0012, tilt: 1.05, duration: 3.5 });
    });

    try {
      const saved = JSON.parse(localStorage.getItem('planeta.lugar') || 'null');
      if (saved?.lat != null) this.place = saved; // se recuerda, pero no se abre solo
    } catch { /* */ }
  }

  async select(place) {
    this.place = place;
    try { localStorage.setItem('planeta.lugar', JSON.stringify(place)); } catch { /* */ }
    latLonToVec3(place.lat, place.lon, 1.004, this.pin.position);
    this.pin.visible = true;
    this.rig.flyTo({ lat: place.lat, lon: place.lon, h: 0.035, tilt: 0, duration: 3 });
    document.body.classList.add('place-open');
    $('place-name').textContent = place.name;
    $('place-rest').textContent = place.rest || '';
    $('place-body').innerHTML = '<p class="pl-loading">Calculando…</p>';
    this.render();
  }

  close() {
    document.body.classList.remove('place-open');
    this.pin.visible = false;
  }

  async render() {
    const p = this.place;
    const now = new Date();
    const [tz, weather, passes] = await Promise.all([
      fetchJSON(`https://api.wheretheiss.at/v1/coordinates/${p.lat.toFixed(3)},${p.lon.toFixed(3)}`, { timeout: 6000 }).then((d) => d.timezone_id).catch(() => null),
      fetchJSON(WEATHER(p.lat, p.lon), { timeout: 8000 }).catch(() => null),
      this.layers.sats?.issPasses(p.lat, p.lon, 72).catch(() => null),
    ]);
    if (this.place !== p) return;
    const timeZone = weather?.timezone || tz || 'UTC';
    let fmtT, fmtD;
    try {
      fmtT = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone });
      fmtD = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone });
    } catch {
      fmtT = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      fmtD = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    }
    const rows = [];
    const row = (k, v, cls = '') => rows.push(`<div class="pl-row ${cls}"><span class="pl-k">${k}</span><span class="pl-v">${v}</span></div>`);

    row('Hora local', `${fmtT.format(now)} <small>${escapeHtml(timeZone.replace('_', ' '))}</small>`);

    // Sol
    const up = latLonToVec3(p.lat, p.lon, 1);
    const elev = (Math.asin(up.dot(this.ctx.earth.uniforms.sunDir.value)) * 180) / Math.PI;
    const st = sunTimes(now, p.lat, p.lon);
    const sunState = elev > 0 ? `De día · sol a ${Math.round(elev)}°` : elev > -6 ? 'Crepúsculo' : 'De noche';
    row('Sol', sunState);
    if (st.polar) row('', st.polar === 'day' ? 'Sol de medianoche: hoy no se pone' : 'Noche polar: hoy no sale');
    else {
      const len = (st.set - st.rise) / 3600000;
      row('Amanece · anochece', `${fmtT.format(st.rise)} · ${fmtT.format(st.set)} <small>${Math.floor(len)} h ${Math.round((len % 1) * 60)} min de luz</small>`);
    }

    // Luna
    const mp = moonPhase(now);
    row('Luna', `${mp.name} · ${Math.round(mp.fraction * 100)} %`);

    // Tiempo
    if (weather?.current) {
      const c = weather.current;
      row('Tiempo ahora', `${Math.round(c.temperature_2m)} °C · ${WMO[c.weather_code] || '—'} <small>viento ${Math.round(c.wind_speed_10m)} km/h · nubes ${c.cloud_cover} %</small>`);
    }

    // Aurora
    const ap = this.layers.aurora?.probabilityAt(p.lat, p.lon);
    if (ap != null) row('Aurora', ap >= 10 ? `<b class="hi">${Math.round(ap)} % de probabilidad</b>` : ap > 2 ? `Baja (${Math.round(ap)} %)` : 'Improbable');

    // Cercanos
    const near = [];
    for (const q of this.layers.quakes?.all || []) {
      const d = haversineKm(p.lat, p.lon, q.lat, q.lon);
      if (d < 500 && q.mag >= 2) near.push({ d, txt: `Terremoto M ${q.mag.toFixed(1)} a ${Math.round(d)} km` });
    }
    for (const it of this.layers.eonet?.items || []) {
      const d = haversineKm(p.lat, p.lon, it.lat, it.lon);
      if (d < 600) near.push({ d, txt: `${it.cat.label}: ${it.ev.title} (${Math.round(d)} km)` });
    }
    near.sort((a, b) => a.d - b.d);
    row('Cerca (24 h)', near.length ? near.slice(0, 3).map((n) => escapeHtml(n.txt)).join('<br>') : 'Nada destacable');

    // Pasos de la ISS
    let issHtml = 'No disponible ahora';
    if (passes?.length) {
      const vis = passes.filter((s) => s.visible).slice(0, 3);
      const list = (vis.length ? vis : passes.slice(0, 2)).map((s) => {
        const mins = Math.max(1, Math.round((s.end - s.start) / 60000));
        return `${fmtD.format(new Date(s.start))} · ${Math.round(s.maxEl)}° · ${mins} min`;
      });
      issHtml = (vis.length ? '<b class="hi">Visible a simple vista</b><br>' : '<small>Pasará, pero de día o en sombra (no se verá)</small><br>') + list.join('<br>');
    } else if (passes && !passes.length) issHtml = 'No pasa por aquí en los próximos 3 días';
    row('ISS sobre ti', issHtml);

    $('place-body').innerHTML = rows.join('');
  }

  update() {
    if (!this.pin.visible) return;
    const h = this.ctx.camera.position.length() - 1;
    this.pin.scale.setScalar(h < 0.01 ? 0.045 : 0.035);
  }
}
