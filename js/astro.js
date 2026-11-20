// Astronomía de bolsillo: Sol, Luna (posición, distancia y fase), salida/puesta
// del sol y tiempo sidéreo. Fórmulas de baja precisión (estilo SunCalc), de sobra
// para dibujar el cielo.
const PI = Math.PI;
const rad = PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // oblicuidad de la eclíptica

const toJulian = (date) => date / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
function eclipticLongitude(M) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + rad * 102.9372 + PI;
}
function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}
function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

/** Tiempo sidéreo de Greenwich en radianes. */
export function gmst(date) {
  const n = toDays(date.getTime());
  return (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360 * rad;
}

const wrapLon = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Punto de la Tierra con la Luna en el cénit y su distancia (km). */
export function moonPosition(date) {
  const m = moonCoords(toDays(date.getTime()));
  return { lat: m.dec / rad, lon: wrapLon((m.ra - gmst(date)) / rad), distKm: m.dist };
}

const PHASES = [
  [0.03, 'Luna nueva'], [0.22, 'Luna creciente'], [0.28, 'Cuarto creciente'], [0.47, 'Gibosa creciente'],
  [0.53, 'Luna llena'], [0.72, 'Gibosa menguante'], [0.78, 'Cuarto menguante'], [0.97, 'Luna menguante'], [1.01, 'Luna nueva'],
];

/** Fase de la Luna: fracción iluminada (0–1), fase (0 nueva → 0,5 llena → 1) y nombre. */
export function moonPhase(date) {
  const d = toDays(date.getTime());
  const s = sunCoords(d), m = moonCoords(d);
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  const fraction = (1 + Math.cos(inc)) / 2;
  const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI;
  return { fraction, phase, name: PHASES.find(([p]) => phase < p)[1] };
}

/** Salida y puesta del sol (Date o null si es día/noche polar) para el día de `date`. */
export function sunTimes(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat;
  const d = toDays(date.getTime());
  const n = Math.round(d - 0.0009 - lw / (2 * PI));
  const ds = 0.0009 + lw / (2 * PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const h0 = -0.833 * rad;
  const cosW = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosW < -1) return { polar: 'day', noon: fromJulian(Jnoon) };
  if (cosW > 1) return { polar: 'night', noon: fromJulian(Jnoon) };
  const w = Math.acos(cosW);
  const a = 0.0009 + (w + lw) / (2 * PI) + n;
  const Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { rise: fromJulian(Jrise), set: fromJulian(Jset), noon: fromJulian(Jnoon) };
}
