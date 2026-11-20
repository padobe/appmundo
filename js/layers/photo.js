// Capa: foto real de la Tierra de ayer (NASA GIBS, satélites VIIRS; sin clave).
// Sustituye la Blue Marble (imagen de archivo) por las nubes, la nieve y el humo de
// verdad del último día completo. Si un satélite no tiene imagen, se prueba otro / otro día.
import * as THREE from 'three';

const LAYERS = ['VIIRS_NOAA21_CorrectedReflectance_TrueColor', 'VIIRS_NOAA20_CorrectedReflectance_TrueColor'];
const URL = (layer, day, w) => 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0'
  + `&LAYERS=${layer}&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${w}&HEIGHT=${w / 2}&FORMAT=image/jpeg&TIME=${day}`;
const MIN_BYTES = 60000; // una imagen casi vacía (sin datos) pesa muy poco

const isoDay = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

export class PhotoLayer {
  id = 'photo';
  name = 'NASA GIBS';

  constructor(ctx) {
    this.ctx = ctx;
    this.visible = true;
    this.loaded = false;
    this.u = ctx.earth.uniforms;
    this.date = null;
    this.onChange = null;
  }

  async start() {
    const w = this.ctx.isMobile ? 2048 : 4096;
    for (const daysAgo of [1, 2]) {
      const day = isoDay(daysAgo * 86400000);
      for (const layer of LAYERS) {
        try {
          const res = await fetch(URL(layer, day, w));
          const blob = await res.blob();
          if (!res.ok || blob.size < MIN_BYTES * (w / 2048)) throw new Error('sin datos');
          // Imagen normal (orientación igual que las demás texturas del globo); se decodifica una sola vez
          const img = new Image();
          const src = window.URL.createObjectURL(blob);
          img.src = src;
          await img.decode();
          window.URL.revokeObjectURL(src);
          const tex = new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy());
          tex.needsUpdate = true;
          this.u.photoMap.value = tex;
          this.loaded = true;
          this.date = day;
          this.ctx.ui.sourceOk(this.id);
          this.ctx.ui.set('photo-date', new Date(`${day}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }));
          this.onChange?.();
          return;
        } catch (e) {
          console.warn('[photo]', layer, day, e.message);
        }
      }
    }
    this.ctx.ui.sourceError(this.id, 'Sin foto de satélite de ayer · se usa la imagen de archivo');
  }

  setVisible(on) { this.visible = on; this.onChange?.(); }
  get active() { return this.visible && this.loaded; }

  update(dt) {
    // La foto es de un día concreto: al viajar a otra fecha (año, eclipses) se vuelve a la imagen de archivo
    const sameDay = this.ctx.time.live || this.ctx.time.span === 'day';
    const target = this.active && sameDay ? 1 : 0;
    const u = this.u.uPhoto;
    u.value += (target - u.value) * Math.min(1, dt * 1.5);
  }
}
