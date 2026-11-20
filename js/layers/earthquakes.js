// Capa: terremotos (USGS, sin clave). Últimas 24 h en directo y, en la repetición de un
// año, los de magnitud ≥ 6. Todos los pulsos son un único InstancedMesh.
// Los marcadores no usan el depth buffer (así no se cortan con las nubes ni con la
// curvatura del planeta): su visibilidad tras el horizonte se calcula en el shader.
// Al hacer clic: ficha con detalles, profundidad en 3D y ondas sísmicas P y S.
import * as THREE from 'three';
import { latLonToVec3, toScreen, isOccluded, EARTH_RADIUS_KM } from '../geo.js';
import { fetchJSON, escapeHtml, timeAgo } from '../net.js';

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const YEAR_QUERY = (from) => `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=6&orderby=time-asc&starttime=${from}`;
const REFRESH_MS = 5 * 60 * 1000;
const DAY_S = 86400;
const YEAR_S = 365 * DAY_S;
const WAVE_SPEEDUP = 120; // las ondas se muestran 120× más rápido que en la realidad
const VP = 7.5, VS = 4.2; // km/s aproximados en la corteza/manto superior

export const MAG_COLORS = [
  { min: -Infinity, color: '#4fd1c5', label: '< 2.5' },
  { min: 2.5, color: '#f6d860', label: '2.5 – 4.5' },
  { min: 4.5, color: '#ff8a3d', label: '4.5 – 6' },
  { min: 6, color: '#ff3d6e', label: '≥ 6' },
];
const colorFor = (m) => [...MAG_COLORS].reverse().find((c) => m >= c.min).color;
const ALERTS = { green: 'verde', yellow: 'amarilla', orange: 'naranja', red: 'roja' };
const ALERT_COLORS = { green: '#57e3a1', yellow: '#f6d860', orange: '#ff8a3d', red: '#ff3d6e' };

const vertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aT;
  attribute float aRing;
  uniform float uScale;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vPhase;
  varying float vT;
  varying float vRing;
  varying float vVis;
  void main() {
    vUv = uv;
    vColor = aColor; vPhase = aPhase; vT = aT; vRing = aRing;
    vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    // Visible solo en la cara que mira a la cámara, con un desvanecido suave en el borde
    float facing = dot(normalize(c), normalize(cameraPosition - c));
    vVis = smoothstep(-0.02, 0.1, facing);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position * uScale, 1.0);
  }
`;

// uNow y aT: segundos desde una referencia común → sirve en directo y en las repeticiones.
const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uNow;
  uniform float uBurst;
  uniform float uLife;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vPhase;
  varying float vT;
  varying float vRing;
  varying float vVis;

  float ring(float r, float t) {
    return smoothstep(0.075, 0.0, abs(r - t)) * pow(1.0 - t, 1.4);
  }

  void main() {
    float age = uNow - vT;
    if (age < 0.0 || vVis < 0.01) discard;
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float speed = mix(0.55, 0.28, vRing);
    float t1 = fract(uTime * speed + vPhase);
    float t2 = fract(t1 + 0.5);
    float rings = max(ring(r, t1), ring(r, t2)) * vRing;
    float core = smoothstep(0.13, 0.04, r);
    float glow = exp(-r * r * 18.0) * 0.55;
    float fresh = mix(1.0, 0.45, clamp(age / uLife, 0.0, 1.0));
    float a = (rings * 0.95 + core + glow) * fresh;
    float b = age / uBurst;
    if (b < 1.0) {
      a += smoothstep(0.1, 0.0, abs(r - b)) * pow(1.0 - b, 1.2) * 1.6;
      a += (1.0 - b) * smoothstep(0.4, 0.0, r) * 0.9;
    }
    a *= vVis;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

export function placeEs(p) {
  if (!p) return 'Ubicación desconocida';
  const m = p.match(/^(\d+(?:\.\d+)?) ?km ([NSEW]{1,3}) of (.+)$/);
  if (m) return `A ${m[1]} km al ${m[2].replace(/W/g, 'O')} de ${m[3]}`;
  const DIRS = { north: 'norte', south: 'sur', east: 'este', west: 'oeste', northeast: 'noreste', northwest: 'noroeste', southeast: 'sureste', southwest: 'suroeste' };
  const d = p.match(/^(north|south|east|west|northeast|northwest|southeast|southwest) of (?:the )?(.+)$/i);
  return d ? `Al ${DIRS[d[1].toLowerCase()]} de ${d[2]}` : p;
}
const regionOf = (p) => (p?.includes(',') ? p.split(',').pop().trim() : placeEs(p).replace(/^A \S+ km al \S+ de /, ''));

function mapFeature(f) {
  const [lon, lat, depth] = f.geometry.coordinates;
  const p = f.properties;
  return {
    id: f.id, lat, lon, depth: depth ?? 0, mag: p.mag, place: p.place, time: p.time, url: p.url,
    tsunami: p.tsunami === 1, alert: p.alert, felt: p.felt, sig: p.sig, magType: p.magType, mmi: p.mmi,
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export class EarthquakesLayer {
  id = 'quakes';
  name = 'USGS';

  constructor(ctx) {
    this.ctx = ctx;
    this.max = ctx.isMobile ? 400 : 900;
    this.items = [];
    this.seen = null;
    this.mesh = null;
    this.mode = 'day';
    this.dayAll = null;
    this.yearAll = null;
    this.uniforms = {
      uTime: { value: 0 }, uNow: { value: 0 }, uBurst: { value: 1200 }, uScale: { value: 1 }, uLife: { value: DAY_S },
    };
    this.base = Date.now() - 400 * DAY_S * 1000; // referencia común (cubre el año de repetición)
    this.visible = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.lastSubUpdate = 0;
    this.buildSelection();
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
  }

  async refresh() {
    try {
      const data = await fetchJSON(FEED);
      const all = (data.features || []).filter((f) => f.geometry?.coordinates && f.properties?.mag != null).map(mapFeature);
      if (this.seen) {
        const fresh = all.filter((q) => !this.seen.has(q.id) && q.mag >= 4.5).sort((a, b) => b.mag - a.mag)[0];
        if (fresh) this.ctx.ui.toast(`Nuevo terremoto M ${fresh.mag.toFixed(1)} · ${placeEs(fresh.place)}`, 'info');
      }
      this.seen = new Set(all.map((q) => q.id));
      this.dayAll = all;
      if (this.mode === 'day') this.use(all);
      this.ctx.ui.sourceOk(this.id);
    } catch (e) {
      console.warn('[quakes]', e);
      this.ctx.ui.sourceError(this.id, this.items.length
        ? 'USGS no responde · mostrando los últimos datos'
        : 'No se pudieron cargar los terremotos · reintentando en 5 min');
    }
  }

  async loadYear() {
    if (this.yearAll || this.yearLoading) return;
    this.yearLoading = true;
    try {
      const from = new Date(Date.now() - YEAR_S * 1000).toISOString().slice(0, 10);
      const data = await fetchJSON(YEAR_QUERY(from), { timeout: 25000 });
      this.yearAll = (data.features || []).filter((f) => f.geometry?.coordinates && f.properties?.mag != null).map(mapFeature);
      if (this.mode === 'year') this.use(this.yearAll);
    } catch (e) {
      console.warn('[quakes] año', e);
      this.ctx.ui.toast('No se pudieron cargar los terremotos del año', 'warn', 'quakes-year');
    } finally {
      this.yearLoading = false;
    }
  }

  /** Cambia entre las 24 h en directo y el año (M ≥ 6) según la línea de tiempo. */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.uniforms.uLife.value = mode === 'year' ? YEAR_S : DAY_S;
    this.deselect();
    if (mode === 'year') { if (this.yearAll) this.use(this.yearAll); else { this.use([]); this.loadYear(); } }
    else if (this.dayAll) this.use(this.dayAll);
  }

  use(all) {
    this.all = all;
    const items = [...all].sort((a, b) => b.mag - a.mag).slice(0, this.max);
    this.items = items;
    this.build(items);
    this.updateStats(true);
  }

  build(items) {
    if (this.mesh) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    const n = items.length;
    const geo = this.geometry.clone();
    const color = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const tAttr = new Float32Array(n);
    const ringAmp = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(geo, this.material, Math.max(n, 1));
    mesh.count = n;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5; // por encima de nubes, auroras y viento

    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1), s = new THREE.Vector3(), nrm = new THREE.Vector3();
    const c = new THREE.Color();
    items.forEach((it, i) => {
      const mag = Math.max(it.mag, 0);
      const size = 0.022 + 0.0062 * Math.pow(mag, 1.7);
      it.pos = latLonToVec3(it.lat, it.lon, 1.004);
      nrm.copy(it.pos).normalize();
      q.setFromUnitVectors(Z, nrm);
      s.set(size, size, size);
      m.compose(it.pos, q, s);
      mesh.setMatrixAt(i, m);
      c.set(colorFor(it.mag)).convertSRGBToLinear();
      color.set([c.r, c.g, c.b], i * 3);
      phase[i] = Math.random();
      tAttr[i] = (it.time - this.base) / 1000;
      ringAmp[i] = THREE.MathUtils.clamp((it.mag - 1.2) / 3, 0.2, 1);
    });
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aT', new THREE.InstancedBufferAttribute(tAttr, 1));
    geo.setAttribute('aRing', new THREE.InstancedBufferAttribute(ringAmp, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = this.visible;
    this.mesh = mesh;
    this.ctx.scene.add(mesh);
  }

  updateStats(force = false) {
    const now = performance.now();
    const { time, ui } = this.ctx;
    const every = time.live ? 20000 : 150;
    if (!force && now - this.lastSubUpdate < every) return;
    this.lastSubUpdate = now;
    if (!this.all) return;
    const T = time.now();
    const seen = time.live ? this.all : this.all.filter((q) => q.time <= T);
    const strongest = seen.reduce((m, q) => (!m || q.mag > m.mag ? q : m), null);
    const latest = seen.reduce((m, q) => (!m || q.time > m.time ? q : m), null);
    ui.set('q-label', this.mode === 'year' ? 'Terremotos M6+ · 1 año' : 'Terremotos · 24 h');
    ui.set('q-count', this.mode === 'year' && this.yearLoading ? '…' : seen.length.toLocaleString('es-ES'));
    const parts = [];
    if (strongest) parts.push(`Mayor: M ${strongest.mag.toFixed(1)} · ${regionOf(strongest.place)}`);
    if (time.live && latest) parts.push(`Último ${timeAgo(latest.time)}`);
    if (!time.live) parts.push(this.mode === 'year' ? 'Repetición del último año' : 'Repetición de las últimas 24 h');
    ui.set('q-sub', parts.join('\n'));
  }

  setVisible(on) {
    this.visible = on;
    if (this.mesh) this.mesh.visible = on;
    if (!on) this.deselect();
  }

  update(dt) {
    const { time, camera } = this.ctx;
    this.setMode(!time.live && time.span === 'year' ? 'year' : 'day');
    this.uniforms.uTime.value += dt;
    this.uniforms.uNow.value = (time.now() - this.base) / 1000;
    // En las repeticiones el tiempo corre muy deprisa: la onda de choque dura ~1,5 s reales
    this.uniforms.uBurst.value = time.live ? 1200 : time.speed * 1.5;
    const h = camera.position.length() - 1;
    this.uniforms.uScale.value = THREE.MathUtils.clamp(h / 2.2, 0.01, 1);
    // Al viajar a otra fecha (eclipses) no hay datos de terremotos de ese momento
    if (this.mesh) this.mesh.visible = this.visible && time.span !== 'event';
    if (time.live !== this.wasLive) { this.wasLive = time.live; this.updateStats(true); }
    this.updateStats();
    this.updateSelection();
  }

  // --- Selección: ficha, profundidad y ondas ----------------------------------------
  buildSelection() {
    const scene = this.ctx.scene;
    this.sel = null;
    // Columna de profundidad (se ve "a través" del suelo, como una radiografía)
    this.column = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.004, gapSize: 0.003, depthTest: false, transparent: true, opacity: 0.85 }));
    this.column.renderOrder = 8;
    this.column.visible = false;
    this.hypo = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
      new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
    this.hypo.renderOrder = 8;
    this.hypo.visible = false;
    // Frentes de onda P (más rápida) y S
    const ringGeo = () => new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(160 * 3), 3));
    this.waveP = new THREE.LineLoop(ringGeo(), new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, depthWrite: false }));
    this.waveS = new THREE.LineLoop(ringGeo(), new THREE.LineBasicMaterial({ color: 0xffb547, transparent: true, depthWrite: false }));
    for (const o of [this.waveP, this.waveS]) { o.renderOrder = 6; o.visible = false; o.frustumCulled = false; }
    scene.add(this.column, this.hypo, this.waveP, this.waveS);
  }

  select(it) {
    this.sel = it;
    this.selAt = performance.now();
    const top = latLonToVec3(it.lat, it.lon, 1.004);
    const bottom = latLonToVec3(it.lat, it.lon, 1 - it.depth / EARTH_RADIUS_KM);
    const cp = this.column.geometry.attributes.position;
    cp.setXYZ(0, top.x, top.y, top.z); cp.setXYZ(1, bottom.x, bottom.y, bottom.z); cp.needsUpdate = true;
    this.column.computeLineDistances();
    this.column.material.color.set(colorFor(it.mag));
    const hp = this.hypo.geometry.attributes.position;
    hp.setXYZ(0, bottom.x, bottom.y, bottom.z); hp.needsUpdate = true;
    this.hypo.material.color.set(colorFor(it.mag));
    this.column.visible = this.hypo.visible = true;
    this.ctx.ui.showDetail(this.detailHtml(it), () => this.deselect());
  }

  deselect() {
    if (!this.sel) return;
    this.sel = null;
    this.column.visible = this.hypo.visible = this.waveP.visible = this.waveS.visible = false;
    this.ctx.ui.hideDetail();
  }

  updateSelection() {
    const it = this.sel;
    if (!it) return;
    const tSim = ((performance.now() - this.selAt) / 1000) * WAVE_SPEEDUP; // segundos "reales" de propagación
    const c = latLonToVec3(it.lat, it.lon, 1);
    const u = new THREE.Vector3(0, 1, 0).cross(c);
    if (u.lengthSq() < 1e-8) u.set(1, 0, 0);
    u.normalize();
    const w = new THREE.Vector3().crossVectors(c, u);
    const draw = (obj, v) => {
      const theta = (v * tSim) / EARTH_RADIUS_KM;
      obj.visible = theta < Math.PI * 0.98;
      if (!obj.visible) return;
      obj.material.opacity = 0.9 * (1 - theta / Math.PI);
      const p = obj.geometry.attributes.position;
      const ct = Math.cos(theta), st = Math.sin(theta);
      for (let i = 0; i < 160; i++) {
        const a = (i / 160) * Math.PI * 2;
        const ca = Math.cos(a) * st, sa = Math.sin(a) * st;
        p.setXYZ(i, (c.x * ct + u.x * ca + w.x * sa) * 1.006, (c.y * ct + u.y * ca + w.y * sa) * 1.006, (c.z * ct + u.z * ca + w.z * sa) * 1.006);
      }
      p.needsUpdate = true;
    };
    draw(this.waveP, VP);
    draw(this.waveS, VS);
    if (!this.waveP.visible && !this.waveS.visible) this.selAt = performance.now(); // se repite
  }

  detailHtml(it) {
    const col = colorFor(it.mag);
    const date = new Date(it.time);
    const fmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
    const rows = [];
    const row = (k, v) => rows.push(`<div class="pl-row"><span class="pl-k">${k}</span><span class="pl-v">${v}</span></div>`);
    row('Cuándo', `${escapeHtml(timeAgo(it.time))}<small>${escapeHtml(fmt.format(date))} (tu hora)</small>`);
    row('Profundidad', `${Math.round(it.depth)} km <small>${it.depth < 70 ? 'superficial' : it.depth < 300 ? 'intermedio' : 'profundo'} · la línea discontinua baja hasta el foco</small>`);
    if (it.tsunami) row('Tsunami', 'Indicador de USGS activo<small>Solo indica que es un evento en zona donde se evalúan avisos; no significa que haya tsunami. Consulta los avisos oficiales.</small>');
    if (it.alert) row('Alerta PAGER', `<span class="badge" style="--c:${ALERT_COLORS[it.alert] || '#ccc'}">${ALERTS[it.alert] || escapeHtml(it.alert)}</span><small>impacto estimado en personas y economía</small>`);
    if (it.felt) row('Sentido por', `${it.felt.toLocaleString('es-ES')} personas <small>que lo notificaron a USGS</small>`);
    if (it.mmi) row('Intensidad', `${it.mmi.toFixed(1)} (escala Mercalli)`);
    // Llegada de las ondas al lugar guardado en "Desde aquí"
    try {
      const pl = JSON.parse(localStorage.getItem('planeta.lugar') || 'null');
      if (pl?.lat != null) {
        const d = haversineKm(it.lat, it.lon, pl.lat, pl.lon);
        const fm = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
        row(`Hasta ${escapeHtml(pl.name)}`, `${Math.round(d).toLocaleString('es-ES')} km <small>onda P en ~${fm(d / VP)} · onda S en ~${fm(d / VS)}</small>`);
      }
    } catch { /* */ }
    row('Ondas', '<span class="wave p">P</span> primaria (~7,5 km/s) · <span class="wave s">S</span> secundaria (~4,2 km/s)<small>animadas 120× más rápido que en la realidad</small>');
    return `
      <div class="pl-kicker" style="color:${col}">Terremoto · M ${it.mag.toFixed(1)}${it.magType ? ` <small>(${escapeHtml(it.magType)})</small>` : ''}</div>
      <div class="pl-name">${escapeHtml(placeEs(it.place))}</div>
      <div class="pl-body">${rows.join('')}</div>
      ${it.url ? `<a class="btn pl-3d" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">Ver en USGS ↗</a>` : ''}`;
  }

  pick(x, y, radius) {
    if (!this.visible) return null;
    const { camera, size, time } = this.ctx;
    const T = time.now();
    const { w, h } = size();
    let best = null;
    for (const it of this.items) {
      if (!it.pos || it.time > T) continue;
      const sp = toScreen(it.pos, camera, w, h);
      if (sp.behind) continue;
      const d = Math.hypot(sp.x - x, sp.y - y);
      const r = radius + Math.min(10, it.mag * 1.5);
      if (d > r) continue;
      if (isOccluded(it.pos, camera.position)) continue;
      const score = d - it.mag * 2;
      if (!best || score < best.score) best = { score, dist: d, it };
    }
    if (!best) return null;
    const it = best.it;
    const col = colorFor(it.mag);
    const badges = [
      it.tsunami ? '<span class="badge" style="--c:#4da3ff">indicador de tsunami</span>' : '',
      it.alert ? `<span class="badge" style="--c:${ALERT_COLORS[it.alert]}">alerta ${ALERTS[it.alert] || ''}</span>` : '',
    ].join('');
    return {
      dist: best.dist,
      select: () => this.select(it),
      html: `
        <div class="tt-kicker" style="--c:${col}"><span class="tt-dot"></span>Terremoto · M ${it.mag.toFixed(1)}</div>
        <div class="tt-title">${escapeHtml(placeEs(it.place))}</div>
        <div class="tt-meta">${escapeHtml(timeAgo(it.time))} · ${Math.round(it.depth)} km de profundidad${it.felt ? ` · sentido por ${it.felt}` : ''}</div>
        ${badges ? `<div class="tt-badges">${badges}</div>` : ''}
        <div class="tt-hint">Clic para ver detalles y ondas</div>`,
    };
  }
}
