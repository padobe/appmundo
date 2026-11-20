// "Geocodificación inversa" aproximada y offline: mares/océanos y grandes regiones
// por cajas de lat/lon. Tierra o agua se decide con la máscara de agua de la textura.

// [nombre, latMin, latMax, lonMin, lonMax]  (lonMin > lonMax = cruza el antimeridiano)
// El orden importa: las cajas más pequeñas primero.
const SEAS = [
  ['Mar Negro', 40.5, 47, 27.5, 42],
  ['Mar Caspio', 36.5, 47.5, 46.5, 55],
  ['Mar Mediterráneo', 30, 46, -6, 36.5],
  ['Mar Báltico', 53.5, 66, 9.5, 30],
  ['Mar del Norte', 51, 61, -4, 9],
  ['Mar Rojo', 12.5, 30, 32, 44],
  ['Golfo Pérsico', 23.5, 30.5, 47.5, 57],
  ['Golfo de México', 18, 31, -98, -81],
  ['Mar Caribe', 9, 22, -88, -60],
  ['Bahía de Hudson', 51, 66, -95, -77],
  ['Mar Arábigo', 5, 25, 50, 77],
  ['Golfo de Bengala', 5, 23, 80, 95],
  ['Mar de China Meridional', 0, 23, 102, 121],
  ['Mar de China Oriental', 23, 33, 119, 130],
  ['Mar de Japón', 33, 52, 127, 142],
  ['Mar de Ojotsk', 43, 62, 135, 163],
  ['Mar de Bering', 52, 66, 162, -157],
  ['Mar de Coral', -25, -9, 145, 165],
  ['Mar de Tasmania', -48, -30, 148, 175],
];

const LANDS = [
  ['la Antártida', -90, -60, -180, 180],
  ['Groenlandia', 59, 84, -74, -11],
  ['Oriente Medio', 12, 42, 34, 63],
  ['Centroamérica', 7, 18.5, -93, -77],
  ['el Sudeste Asiático', -11, 7, 95, 141],
  ['Oceanía', -50, -10, 110, 180],
  ['Europa', 35, 72, -25, 40],
  ['África', -35, 37.5, -18, 52],
  ['Sudamérica', -56, 13, -82, -34],
  ['Norteamérica', 15, 84, -170, -50],
  ['Asia', -11, 80, 25, 180],
  ['Asia', 60, 72, -180, -168],
  ['una isla del Pacífico', -35, 30, 150, -100],
];

function inBox(lat, lon, [, a, b, c, d]) {
  if (lat < a || lat > b) return false;
  return c <= d ? lon >= c && lon <= d : lon >= c || lon <= d;
}

function ocean(lat, lon) {
  if (lat <= -60) return 'el Océano Antártico';
  if (lat >= 66) return 'el Océano Ártico';
  const sea = SEAS.find((s) => inBox(lat, lon, s));
  if (sea) return `el ${sea[0]}`;
  if ((lon >= 20 && lon < 120 && lat < 25) || (lon >= 120 && lon < 147 && lat < -10)) {
    return 'el Océano Índico';
  }
  const atlantic = lat > 8 ? lon > -80 && lon < 20 : lon > -70 && lon < 20;
  const hemi = lat >= 0 ? 'Norte' : 'Sur';
  return atlantic ? `el Atlántico ${hemi}` : `el Pacífico ${hemi}`;
}

function land(lat, lon) {
  const l = LANDS.find((b) => inBox(lat, lon, b));
  return l ? l[0] : 'tierra firme';
}

/** Devuelve { water, name } con una descripción corta: "el Atlántico Norte", "África"… */
export function describePlace(lat, lon, isWater) {
  const water = isWater ?? true;
  return { water, name: water ? ocean(lat, lon) : land(lat, lon) };
}
