// Índice de eventos GDACS (ONU + Comisión Europea): terremotos, ciclones, inundaciones,
// incendios y volcanes con su nivel de alerta. Gratis, sin clave y con CORS abierto.
import { fetchJSON } from '../net.js';

export const LIST_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';

export const TYPES = {
  EQ: { label: 'Terremoto', glyph: 'dot' },
  TC: { label: 'Ciclón tropical', glyph: 'storm' },
  FL: { label: 'Inundación', glyph: 'drop' },
  WF: { label: 'Incendio forestal', glyph: 'fire' },
  VO: { label: 'Volcán', glyph: 'volcano' },
  DR: { label: 'Sequía', glyph: 'dot' },
};

export const ALERT = {
  Green: { label: 'Alerta verde', color: '#5fd38d', size: 0.018 },
  Orange: { label: 'Alerta naranja', color: '#ffb547', size: 0.023 },
  Red: { label: 'Alerta roja', color: '#ff5a4d', size: 0.028 },
};

/** Las fechas de GDACS vienen sin zona: son UTC. */
export const utc = (s) => (s ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : NaN);

export function normalise(f) {
  const p = f.properties || {};
  const c = f.geometry?.coordinates;
  if (!c || !TYPES[p.eventtype]) return null;
  const from = utc(p.fromdate);
  const to = utc(p.todate);
  return {
    key: `${p.eventtype}${p.eventid}`,
    type: p.eventtype,
    id: p.eventid,
    name: p.eventname && p.eventtype === 'TC' ? `${TYPES.TC.label} ${p.eventname}` : (p.name || TYPES[p.eventtype].label),
    country: p.country || '',
    alert: ALERT[p.alertlevel] ? p.alertlevel : 'Green',
    from: Number.isFinite(from) ? from : Date.now(),
    to: Number.isFinite(to) ? to : (Number.isFinite(from) ? from : Date.now()),
    modified: utc(p.datemodified),
    lat: c[1],
    lon: c[0],
    severity: p.severitydata || null,
    source: p.source || '',
    reportUrl: p.url?.report || '',
    geometryUrl: p.url?.geometry || '',
    detailsUrl: p.url?.details || '',
  };
}

export async function loadEventList() {
  const d = await fetchJSON(LIST_URL, { timeout: 20000 });
  return (d.features || []).map(normalise).filter(Boolean);
}
