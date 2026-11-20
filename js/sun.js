// Punto subsolar (donde el sol está en el cénit) para un instante dado.
// Algoritmo de baja precisión del Astronomical Almanac (~0.01°), más que suficiente.
const D2R = Math.PI / 180;

export function subsolarPoint(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0; // días desde J2000
  const L = 280.46 + 0.9856474 * n; // longitud media
  const g = (357.528 + 0.9856003 * n) * D2R; // anomalía media
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R; // longitud eclíptica
  const eps = (23.439 - 0.0000004 * n) * D2R; // oblicuidad
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = 280.46061837 + 360.98564736629 * n; // tiempo sidéreo de Greenwich (grados)
  const lon = ((((ra / D2R - gmst) % 360) + 540) % 360) - 180;
  return { lat: dec / D2R, lon };
}
