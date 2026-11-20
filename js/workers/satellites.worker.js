// Worker: propaga órbitas (SGP4, satellite.js) fuera del hilo principal.
// Mensajes:
//  { type: 'groups', groups: { id: tleText } }   → carga satélites
//  { type: 'tick', t }                             → posiciones en t y t + STEP
//  { type: 'passes', lat, lon, from, hours }       → pasos visibles de la ISS
/* global satellite */
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const R = 6371;
const STEP_MS = 2000;
let sats = []; // { name, group, rec }
let iss = null;

function parseTle(text, group) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i]?.trim(), l1 = lines[i + 1], l2 = lines[i + 2];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    try {
      const rec = satellite.twoline2satrec(l1, l2);
      out.push({ name, group, rec, id: l1.slice(2, 7).trim() });
    } catch { /* TLE inválido */ }
  }
  return out;
}

/** Posición en el sistema de la escena (radios terrestres, eje Y = norte). */
function scenePos(rec, date, gmst, out, k) {
  const pv = satellite.propagate(rec, date);
  const p = pv && pv.position;
  if (!p || Number.isNaN(p.x)) { out[k] = out[k + 1] = out[k + 2] = 0; return false; }
  const e = satellite.eciToEcf(p, gmst);
  out[k] = e.x / R; out[k + 1] = e.z / R; out[k + 2] = -e.y / R;
  return true;
}

function sunEci(date) {
  // Dirección del sol (ECI) de baja precisión, para saber si un satélite está iluminado
  const n = date.getTime() / 86400000 - 10957.5;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
}

function passes(lat, lon, from, hours) {
  if (!iss) return [];
  const obs = { latitude: lat * Math.PI / 180, longitude: lon * Math.PI / 180, height: 0.05 };
  const out = [];
  let cur = null;
  for (let t = from; t < from + hours * 3600000; t += 20000) {
    const date = new Date(t);
    const pv = satellite.propagate(iss.rec, date);
    if (!pv.position) continue;
    const gmst = satellite.gstime(date);
    const look = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst));
    const el = look.elevation * 180 / Math.PI;
    if (el > 10) {
      // ¿Visible? Observador de noche y la ISS al sol (fuera de la sombra cilíndrica de la Tierra)
      const s = sunEci(date);
      const obsEci = satellite.ecfToEci(satellite.geodeticToEcf(obs), gmst);
      const ol = Math.hypot(obsEci.x, obsEci.y, obsEci.z);
      const sunElev = Math.asin((obsEci.x * s.x + obsEci.y * s.y + obsEci.z * s.z) / ol) * 180 / Math.PI;
      const p = pv.position;
      const dot = p.x * s.x + p.y * s.y + p.z * s.z;
      const perp = Math.sqrt(Math.max(0, p.x * p.x + p.y * p.y + p.z * p.z - dot * dot));
      const lit = dot > 0 || perp > R;
      const visible = sunElev < -6 && lit;
      if (!cur) cur = { start: t, end: t, maxEl: el, visible };
      cur.end = t;
      if (el > cur.maxEl) cur.maxEl = el;
      cur.visible = cur.visible || visible;
    } else if (cur) {
      out.push(cur);
      cur = null;
      if (out.length >= 12) break;
    }
  }
  return out;
}

self.onmessage = ({ data }) => {
  if (data.type === 'groups') {
    sats = [];
    for (const [group, text] of Object.entries(data.groups)) sats.push(...parseTle(text, group));
    iss = sats.find((s) => s.id === '25544') || iss;
    // La ISS tiene su propia capa: no se duplica
    sats = sats.filter((s) => s.id !== '25544');
    self.postMessage({ type: 'meta', names: sats.map((s) => s.name), groups: sats.map((s) => s.group) });
  } else if (data.type === 'tick') {
    const n = sats.length;
    const a = new Float32Array(n * 3), b = new Float32Array(n * 3);
    const d0 = new Date(data.t), d1 = new Date(data.t + STEP_MS);
    const g0 = satellite.gstime(d0), g1 = satellite.gstime(d1);
    for (let i = 0; i < n; i++) {
      scenePos(sats[i].rec, d0, g0, a, i * 3);
      scenePos(sats[i].rec, d1, g1, b, i * 3);
    }
    self.postMessage({ type: 'pos', t: data.t, step: STEP_MS, a, b }, [a.buffer, b.buffer]);
  } else if (data.type === 'passes') {
    self.postMessage({ type: 'passes', id: data.id, passes: passes(data.lat, data.lon, data.from, data.hours) });
  }
};
