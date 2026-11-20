// Capa: Estación Espacial Internacional en directo (wheretheiss.at).
// Se muestra con unos segundos de retraso para poder interpolar entre muestras
// reales sobre el círculo máximo → movimiento fluido sin saltos.
import * as THREE from 'three';
import { EARTH_RADIUS_KM, latLonToVec3, vec3ToLatLon, greatCircle, toScreen, isOccluded, formatLatLon } from '../geo.js';
import { fetchJSON } from '../net.js';
import { describePlace } from '../regions.js';

const API = 'https://api.wheretheiss.at/v1/satellites/25544';
const POLL_MS = 5000;
const DELAY_S = 8; // retraso de visualización
const TRAIL_S = 30 * 60; // 30 min de estela
const ISS_COLOR = new THREE.Color('#7ee8ff');

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['es'], { type: 'region' }); } catch { /* sin soporte */ }

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(210,248,255,0.95)');
  grd.addColorStop(0.32, 'rgba(126,232,255,0.35)');
  grd.addColorStop(1, 'rgba(126,232,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class IssLayer {
  id = 'iss';
  name = 'ISS';

  constructor(ctx) {
    this.ctx = ctx;
    this.samples = []; // {t, v (unit), alt, vel, vis, footprint}
    this.clockOffset = null; // segundos servidor - cliente
    this.position = new THREE.Vector3(); // posición mostrada (mundo)
    this.sub = new THREE.Vector3(); // punto bajo la ISS (unitario)
    this.state = null;
    this.lastTrailAt = 0;
    this.lastRegionAt = 0;
    this.lastCountryAt = 0;
    this.country = null;
    this.region = null;
    this.pollTimer = null;
    this.build();
  }

  build() {
    const { scene } = this.ctx;
    const tex = glowTexture();
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.marker.scale.setScalar(0.08);
    this.marker.renderOrder = 4;
    this.marker.visible = false;
    scene.add(this.marker);

    // Estela: tubo fino que se desvanece hacia atrás (un solo mesh, sin solapes)
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: ISS_COLOR.clone().convertSRGBToLinear() } },
      vertexShader: `varying float vAlong; void main(){ vAlong = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlong;
        void main() {
          float a = pow(vAlong, 1.8) * 0.95;
          gl_FragColor = vec4(uColor + vec3(0.5) * pow(vAlong, 30.0), a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Mesh(new THREE.BufferGeometry(), this.trailMat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 3;
    this.trail.visible = false;
    scene.add(this.trail);

    // Línea vertical hasta el suelo + huella de visibilidad
    const thin = new THREE.LineBasicMaterial({
      color: ISS_COLOR, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.drop = new THREE.Line(new THREE.BufferGeometry().setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(6), 3)), thin);
    this.drop.frustumCulled = false;
    this.drop.visible = false;
    scene.add(this.drop);

    this.FOOT_N = 128;
    const footMat = thin.clone();
    footMat.opacity = 0.22;
    this.footprint = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(this.FOOT_N * 3), 3)), footMat);
    this.footprint.frustumCulled = false;
    this.footprint.visible = false;
    scene.add(this.footprint);

    this.label = document.getElementById('iss-label');
  }

  start() {
    this.backfill().finally(() => {
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.poll();
    });
  }

  serverNow() {
    return Date.now() / 1000 + (this.clockOffset ?? 0);
  }

  addSample(d) {
    const t = Number(d.timestamp);
    if (!Number.isFinite(t) || this.samples.some((s) => s.t === t)) return;
    const s = {
      t,
      v: latLonToVec3(+d.latitude, +d.longitude, 1),
      alt: +d.altitude,
      vel: +d.velocity,
      vis: d.visibility,
      footprint: +d.footprint,
    };
    const last = this.samples[this.samples.length - 1];
    // Si hubo un hueco largo (pestaña oculta, red caída) la interpolación ya no vale
    if (last && t - last.t > 180) this.samples.length = 0;
    this.samples.push(s);
    this.samples.sort((a, b) => a.t - b.t);
    const cutoff = t - TRAIL_S - 60;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  async backfill() {
    // Últimos 27 min (máx. 10 marcas de tiempo por petición) → estela inmediata
    const now = Math.floor(Date.now() / 1000);
    const ts = Array.from({ length: 10 }, (_, i) => now - (9 - i) * 180);
    try {
      const list = await fetchJSON(`${API}/positions?timestamps=${ts.join(',')}&units=kilometers`);
      if (Array.isArray(list)) list.forEach((d) => this.addSample(d));
    } catch (e) {
      console.warn('[iss] backfill', e);
    }
  }

  async poll() {
    if (document.hidden) return;
    try {
      const d = await fetchJSON(API, { timeout: 8000 });
      const offset = Number(d.timestamp) - Date.now() / 1000;
      this.clockOffset = this.clockOffset == null ? offset : this.clockOffset * 0.8 + offset * 0.2;
      const last = this.samples[this.samples.length - 1];
      if (last && d.timestamp - last.t > 180) {
        this.samples.length = 0;
        await this.backfill();
      }
      this.addSample(d);
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[iss]', e);
      this.ctx.ui.sourceError(this.id, 'Sin conexión con la ISS · reintentando');
    }
  }

  /** Estado interpolado en el instante T (segundos). */
  stateAt(T, out) {
    const s = this.samples;
    const n = s.length;
    if (!n) return null;
    let a, b, f;
    if (n === 1 || T <= s[0].t) {
      a = b = s[0]; f = 0;
    } else if (T >= s[n - 1].t) {
      a = s[n - 2]; b = s[n - 1];
      const ahead = Math.min(T - b.t, 60); // extrapola como mucho 1 min
      f = 1 + ahead / (b.t - a.t);
    } else {
      let i = 0;
      while (s[i + 1].t <= T) i++;
      a = s[i]; b = s[i + 1];
      f = (T - a.t) / (b.t - a.t);
    }
    greatCircle(a.v, b.v, f, out);
    const k = Math.min(f, 1);
    return {
      alt: a.alt + (b.alt - a.alt) * k,
      vel: a.vel + (b.vel - a.vel) * k,
      vis: (f < 0.5 ? a : b).vis,
      footprint: b.footprint,
    };
  }

  rebuildTrail(T) {
    const s = this.samples;
    const pts = [];
    const tmp = new THREE.Vector3();
    const push = (v, alt) => pts.push(v.clone().multiplyScalar(1 + alt / EARTH_RADIUS_KM));
    for (let i = 0; i < s.length; i++) {
      const cur = s[i], next = s[i + 1];
      if (cur.t > T) break;
      if (next && next.t < T - TRAIL_S) continue;
      push(cur.v, cur.alt);
      if (next && next.t <= T) {
        const gap = next.t - cur.t;
        const steps = gap > 20 ? Math.ceil(gap / 15) : 1;
        for (let j = 1; j < steps; j++) {
          const f = j / steps;
          push(greatCircle(cur.v, next.v, f, tmp), cur.alt + (next.alt - cur.alt) * f);
        }
      }
    }
    pts.push(this.position.clone());
    if (pts.length < 3) { this.trail.visible = false; return; }
    const curve = new THREE.CatmullRomCurve3(pts);
    const segs = Math.min(700, pts.length * 2);
    const radius = this.ctx.isMobile ? 0.0042 : 0.0032;
    this.trail.geometry.dispose();
    this.trail.geometry = new THREE.TubeGeometry(curve, segs, radius, 5, false);
    this.trail.visible = true;
  }

  update(dt) {
    const { camera, size, ui } = this.ctx;
    const T = this.serverNow() - DELAY_S;
    const st = this.stateAt(T, this.sub);
    if (!st) return;
    this.state = st;

    const r = 1 + st.alt / EARTH_RADIUS_KM;
    this.position.copy(this.sub).multiplyScalar(r);

    // Marcador con un pulso suave
    const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.12;
    this.marker.position.copy(this.position);
    this.marker.scale.setScalar(0.075 * pulse);
    this.marker.visible = true;

    // Estela: la ISS se mueve ~0,07°/s, basta con reconstruirla una vez por segundo
    const nowMs = performance.now();
    if (nowMs - this.lastTrailAt > 1000) {
      this.lastTrailAt = nowMs;
      this.rebuildTrail(T);
    }

    // Línea al suelo
    const dp = this.drop.geometry.attributes.position;
    dp.setXYZ(0, this.sub.x * 1.002, this.sub.y * 1.002, this.sub.z * 1.002);
    dp.setXYZ(1, this.position.x, this.position.y, this.position.z);
    dp.needsUpdate = true;
    this.drop.visible = true;

    // Huella: zona de la Tierra desde la que se ve la ISS
    if (st.footprint > 0) {
      const theta = st.footprint / 2 / EARTH_RADIUS_KM;
      const c = this.sub;
      const u = new THREE.Vector3(0, 1, 0).cross(c);
      if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
      u.normalize();
      const w = new THREE.Vector3().crossVectors(c, u);
      const fp = this.footprint.geometry.attributes.position;
      const ct = Math.cos(theta), stt = Math.sin(theta);
      for (let i = 0; i < this.FOOT_N; i++) {
        const phi = (i / this.FOOT_N) * Math.PI * 2;
        const cp = Math.cos(phi) * stt, sp = Math.sin(phi) * stt;
        fp.setXYZ(i,
          (c.x * ct + u.x * cp + w.x * sp) * 1.002,
          (c.y * ct + u.y * cp + w.y * sp) * 1.002,
          (c.z * ct + u.z * cp + w.z * sp) * 1.002);
      }
      fp.needsUpdate = true;
      this.footprint.visible = true;
    }

    // Etiqueta HTML que sigue al marcador
    const { w: W, h: H } = size();
    const sp = toScreen(this.position, camera, W, H);
    const hidden = sp.behind || isOccluded(this.position, camera.position);
    if (this.label) {
      this.label.style.transform = `translate(${sp.x.toFixed(1)}px, ${sp.y.toFixed(1)}px)`;
      this.label.classList.toggle('hidden', hidden);
    }

    // Región sobrevolada (cada 4 s; país vía API cada 20 s si está sobre tierra)
    const now = performance.now();
    if (now - this.lastRegionAt > 4000) {
      this.lastRegionAt = now;
      const { lat, lon } = vec3ToLatLon(this.sub);
      this.lat = lat; this.lon = lon;
      const place = describePlace(lat, lon, this.ctx.earth.isWater(lat, lon));
      if (place.water) this.country = null;
      else if (now - this.lastCountryAt > 20000) {
        this.lastCountryAt = now;
        this.lookupCountry(lat, lon);
      }
      this.region = place.name;
      const shown = this.country || place.name.replace(/^(el|la) /, '');
      ui.set('iss-region', shown.charAt(0).toUpperCase() + shown.slice(1));
      ui.set('iss-sub', `${Math.round(st.alt)} km · ${Math.round(st.vel).toLocaleString('es-ES')} km/h\n${formatLatLon(lat, lon)}`);
    }
  }

  async lookupCountry(lat, lon) {
    try {
      const d = await fetchJSON(`https://api.wheretheiss.at/v1/coordinates/${lat.toFixed(2)},${lon.toFixed(2)}`, { timeout: 6000 });
      const code = d?.country_code;
      this.country = code && code !== '??' && regionNames ? regionNames.of(code) : null;
    } catch {
      this.country = null; // la región aproximada basta
    }
  }

  pick(x, y, radius) {
    if (!this.state) return null;
    const { camera, size } = this.ctx;
    const { w, h } = size();
    const sp = toScreen(this.position, camera, w, h);
    const d = Math.hypot(sp.x - x, sp.y - y);
    if (sp.behind || d > radius + 14 || isOccluded(this.position, camera.position)) return null;
    const st = this.state;
    const where = this.country || this.region || '';
    const light = st.vis === 'daylight' ? 'Iluminada por el sol' : 'En la sombra de la Tierra';
    return {
      dist: Math.max(0, d - 8),
      html: `
        <div class="tt-kicker" style="--c:#7ee8ff"><span class="tt-dot"></span>Estación Espacial Internacional</div>
        <div class="tt-title">Sobre ${where}</div>
        <div class="tt-meta">${Math.round(st.alt)} km de altitud · ${Math.round(st.vel).toLocaleString('es-ES')} km/h<br>${light} · ${formatLatLon(this.lat ?? 0, this.lon ?? 0)}</div>`,
    };
  }
}
