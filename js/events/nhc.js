// Ciclones del Atlántico y del Pacífico este/central con los productos oficiales del NHC
// (servicio ArcGIS de NOAA, con CORS): cono de previsión, trayectoria prevista y radios de viento.
import { fetchJSON } from '../net.js';

const BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
// Grupo de cada hueco de tormenta (AT1-5, EP1-5, CP1-5); las subcapas van a desplazamientos fijos
const SLOTS = { AT: [4, 30, 56, 82, 108], EP: [134, 160, 186, 212, 238], CP: [264, 290, 316, 342, 368] };
const SUB = { points: 2, track: 3, cone: 4, pastTrack: 8, radii: 12 };
const q = (id) => fetchJSON(`${BASE}/${id}/query?where=1%3D1&outFields=*&f=geojson`, { timeout: 12000 });

/** Cuencas del NHC según la posición (null fuera de su zona: p. ej. Pacífico sur, Índico). */
function basins(lat, lon) {
  if (lat < 0) return [];
  if (lon > -100 && lon < 0) return lon < -80 ? ['AT', 'EP'] : ['AT'];
  if (lon <= -100 && lon > -140) return ['EP'];
  if (lon <= -140 || lon >= 170) return ['CP', 'EP'];
  return [];
}

/** Nombre corto de la tormenta a partir del de GDACS («Ciclón tropical MELISSA-25» → «MELISSA»). */
const shortName = (name) => (/([A-Z]{3,})(?:-\d+)?\s*$/.exec(name || '') || [])[1] || '';

export const nhcCovers = (evt) => basins(evt.lat, evt.lon).length > 0;

/** Productos NHC del ciclón, o null si el NHC no lo tiene activo. */
export async function loadNhc(evt) {
  const name = shortName(evt.name);
  const groups = basins(evt.lat, evt.lon).flatMap((b) => SLOTS[b]);
  if (!name || !groups.length) return null;
  const found = await Promise.all(groups.map(async (g) => {
    try {
      const d = await q(g + SUB.points);
      const hit = (d.features || []).some((f) => Object.values(f.properties || {}).some((v) => typeof v === 'string' && v.toUpperCase().includes(name)));
      return hit ? { g, points: d.features } : null;
    } catch { return null; }
  }));
  const slot = found.find(Boolean);
  if (!slot) return null;
  const [cone, track, radii, past] = await Promise.allSettled([q(slot.g + SUB.cone), q(slot.g + SUB.track), q(slot.g + SUB.radii), q(slot.g + SUB.pastTrack)]);
  const props = slot.points[0]?.properties || {};
  const adv = props.ADVISNUM ?? props.advisnum ?? props.ADVISORY ?? '';
  return {
    name,
    advisory: String(adv),
    cone: cone.value?.features || [],
    track: track.value?.features || [],
    radii: radii.value?.features || [],
    past: past.value?.features || [],
    points: slot.points,
  };
}

/** Umbral de un polígono de radios de viento (34, 50 o 64 nudos). */
export function radiiKt(f) {
  const p = f.properties || {};
  const v = p.RADII ?? p.radii ?? p.WINDSPEED ?? p.windspeed;
  return Number(v) || 0;
}
