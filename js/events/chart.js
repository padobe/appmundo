// Gráfica genérica de series temporales con cursor sincronizado con la línea de tiempo.
// Serie: { label, unit, color, points: [{ t, v, forecast }] }. Las líneas entre puntos son
// solo guías visuales: los puntos son los datos reales; la previsión va en discontinuo.
const TEXT = '#aab2c5';
const GRID = 'rgba(255,255,255,.08)';

const fmtDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export class EventChart {
  constructor(canvas, onSeek) {
    this.c = canvas;
    this.onSeek = onSeek;
    this.series = [];
    this.domain = [0, 1];
    this.cursor = null;
    let drag = false;
    const seek = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.pad.l) / (r.width - this.pad.l - this.pad.r);
      this.onSeek?.(this.domain[0] + Math.min(1, Math.max(0, x)) * (this.domain[1] - this.domain[0]));
    };
    canvas.addEventListener('pointerdown', (e) => { drag = true; canvas.setPointerCapture(e.pointerId); seek(e); });
    canvas.addEventListener('pointermove', (e) => { if (drag) seek(e); });
    canvas.addEventListener('pointerup', () => { drag = false; });
    canvas.addEventListener('pointercancel', () => { drag = false; });
  }

  pad = { l: 38, r: 8, t: 8, b: 18 };

  set(series, window) {
    this.series = series;
    const ts = series.flatMap((s) => s.points.map((p) => p.t));
    this.domain = [Math.min(window.start, ...ts), Math.max(window.end, ...ts)];
    this.draw();
  }

  setCursor(t) {
    if (t === this.cursor) return;
    this.cursor = t;
    this.draw();
  }

  draw() {
    const c = this.c;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { l, r, t, b } = this.pad;
    const [t0, t1] = this.domain;
    const vmax = Math.max(1e-9, ...this.series.flatMap((s) => s.points.map((p) => p.v))) * 1.1;
    const X = (tt) => l + ((tt - t0) / (t1 - t0 || 1)) * (w - l - r);
    const Y = (v) => t + (1 - v / vmax) * (h - t - b);

    g.font = '10px ui-monospace, Menlo, monospace';
    g.fillStyle = TEXT; g.strokeStyle = GRID; g.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const v = (vmax * i) / 3, y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(l, y); g.lineTo(w - r, y); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle';
      g.fillText(String(Math.round(v)), l - 5, y);
    }
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left'; g.fillText(fmtDay.format(t0), l, h - 4);
    g.textAlign = 'right'; g.fillText(fmtDay.format(t1), w - r, h - 4);

    for (const s of this.series) {
      if (s.bars) {
        const bw = Math.max(2, ((w - l - r) * 86400000 * 0.7) / (t1 - t0 || 1));
        g.fillStyle = s.color;
        for (const p of s.points) g.fillRect(X(p.t) - bw / 2, Y(p.v), bw, Y(0) - Y(p.v));
        continue;
      }
      const pts = [...s.points].sort((a, b2) => a.t - b2.t);
      g.strokeStyle = s.color; g.lineWidth = 1.6;
      for (let i = 1; i < pts.length; i++) {
        g.setLineDash(pts[i].forecast ? [4, 3] : []);
        g.beginPath(); g.moveTo(X(pts[i - 1].t), Y(pts[i - 1].v)); g.lineTo(X(pts[i].t), Y(pts[i].v)); g.stroke();
      }
      g.setLineDash([]);
      for (const p of pts) {
        g.beginPath(); g.arc(X(p.t), Y(p.v), 2.6, 0, Math.PI * 2);
        if (p.forecast) { g.strokeStyle = s.color; g.stroke(); } else { g.fillStyle = s.color; g.fill(); }
      }
    }
    if (this.cursor != null && this.cursor >= t0 && this.cursor <= t1) {
      const x = Math.round(X(this.cursor)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, t); g.lineTo(x, h - b); g.stroke();
    }
  }
}
