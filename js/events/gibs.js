// Imágenes reales de satélite de un día concreto (NASA GIBS, WMS en lat/lon, sin clave).
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
export const TRUE_COLOR = 'VIIRS_NOAA20_CorrectedReflectance_TrueColor';
export const FLOOD_BANDS = 'MODIS_Terra_CorrectedReflectance_Bands721'; // agua en azul oscuro, vegetación verde

export const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Descarga la imagen de `layer` para `day` (AAAA-MM-DD) en `box`. Devuelve un canvas. */
export async function gibsImage(layer, day, box, maxPx = 2048) {
  const lonSpan = box.e - box.w, latSpan = box.n - box.s;
  const k = maxPx / Math.max(lonSpan, latSpan);
  const W = Math.max(64, Math.round(lonSpan * k)), H = Math.max(64, Math.round(latSpan * k));
  const url = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=&CRS=EPSG:4326&BBOX=${box.s},${box.w},${box.n},${box.e}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/jpeg&TIME=${day}`;
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`GIBS HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

/** Fracción de píxeles negros (sin pasada del satélite ese día). */
export function blackFraction(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const s = document.createElement('canvas');
  s.width = s.height = 32;
  s.getContext('2d').drawImage(canvas, 0, 0, 32, 32);
  const d = s.getContext('2d').getImageData(0, 0, 32, 32).data;
  let black = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 20) black++;
  void g;
  return black / 1024;
}

/** La imagen más reciente con datos (prueba ayer, anteayer…). */
export async function latestImage(layer, box, { from = Date.now() - 86400000, tries = 3, maxPx } = {}) {
  for (let i = 0; i < tries; i++) {
    const day = isoDay(from - i * 86400000);
    try {
      const c = await gibsImage(layer, day, box, maxPx);
      if (blackFraction(c) < 0.35) return { canvas: c, day };
    } catch { /* se prueba el día anterior */ }
  }
  return null;
}

/** Nubes: convierte la imagen en color en nubes blancas con transparencia (el mar y la tierra se ven debajo). */
export function cloudsOnly(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
    const sat = (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
    let a = (l - 0.38) / 0.35 - sat * 1.5;
    a = Math.max(0, Math.min(1, a));
    d[i + 3] = a * 235;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
