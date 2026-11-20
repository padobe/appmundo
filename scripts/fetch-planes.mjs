// Descarga los aviones en vuelo de OpenSky Network y los guarda compactados en
// data/planes.json. Lo ejecuta la GitHub Action cada 15 min (OpenSky no permite
// llamadas directas desde el navegador de otros dominios).
//
// Uso local:  node scripts/fetch-planes.mjs
// Opcional: OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET (cuenta gratuita) para más cuota.
import { writeFile, mkdir } from 'node:fs/promises';

const API = 'https://opensky-network.org/api/states/all';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

async function token() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  return (await res.json()).access_token;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

async function main() {
  const t = await token().catch((e) => { console.warn('Sin token:', e.message); return null; });
  const res = await fetch(API, {
    headers: { 'User-Agent': 'planeta-en-vivo', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const data = await res.json();

  const countries = [];
  const ci = new Map();
  const rows = [];
  // state: [icao24, callsign, country, timePos, lastContact, lon, lat, baroAlt, onGround, velocity, track, vRate, sensors, geoAlt, ...]
  for (const s of data.states || []) {
    const [, callsign, country, , , lon, lat, baro, onGround, vel, track, , , geo] = s;
    if (lat == null || lon == null || onGround || !vel || track == null) continue;
    const alt = geo ?? baro ?? 0;
    if (!ci.has(country)) { ci.set(country, countries.length); countries.push(country); }
    rows.push([round(lat, 3), round(lon, 3), Math.round(alt), Math.round(track), Math.round(vel), (callsign || '').trim(), ci.get(country)]);
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/planes.json', JSON.stringify({ t: data.time, c: countries, f: rows }));
  console.log(`OK: ${rows.length} aviones (${new Date(data.time * 1000).toISOString()})`);
}

main().catch((e) => {
  console.error('No se pudo actualizar data/planes.json:', e.message);
  process.exit(1);
});
