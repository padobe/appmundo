// Reloj de la escena: en directo o en una repetición. Todas las capas preguntan aquí
// la hora en vez de usar Date.now().
//  - span 'day':   últimas 24 h (en ~36 s)
//  - span 'year':  último año (en ~60 s). Se avanza de día en día a la misma hora,
//                  así se ven las estaciones sin que el planeta gire como loco.
//  - span 'event': una ventana alrededor de un momento concreto (p. ej. un eclipse)
const DAY = 86400000;
const SPANS = {
  day: { length: DAY, seconds: 36 },
  year: { length: 365 * DAY, seconds: 60 },
};

export class Timeline {
  constructor() {
    this.live = true;
    this.playing = false;
    this.span = 'day';
    this.t = Date.now();
    this.event = null; // { start, end, label, speed }
    this.listeners = new Set();
  }

  get speed() {
    if (this.span === 'event' && this.event) return this.event.speed;
    const s = SPANS[this.span] || SPANS.day;
    return s.length / (s.seconds * 1000);
  }

  range() {
    if (this.span === 'event' && this.event) return { start: this.event.start, end: this.event.end };
    const len = (SPANS[this.span] || SPANS.day).length;
    const end = Date.now();
    return { start: end - len, end };
  }

  now() {
    if (this.live) return Date.now();
    if (this.span === 'year') {
      // Mismo momento del día, saltando de día en día
      const n = Date.now();
      return n - Math.round((n - this.t) / DAY) * DAY;
    }
    return this.t;
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  goLive() {
    this.live = true;
    this.playing = false;
    if (this.span === 'event') { this.span = 'day'; this.event = null; }
    this.emit();
  }

  setSpan(span) {
    if (span === this.span) return;
    this.span = span;
    this.event = null;
    if (!this.live) this.t = this.range().start;
    this.emit();
  }

  /** Viaje a un momento concreto: ventana [start, end] reproducida a `speed`× */
  travel({ start, end, label, speed }) {
    this.span = 'event';
    this.event = { start, end, label, speed };
    this.live = false;
    this.t = start;
    this.playing = true;
    this.emit();
  }

  /** f ∈ [0, 1] dentro del rango actual */
  seek(f) {
    if (f >= 0.999 && this.span !== 'event') { this.goLive(); return; }
    const { start, end } = this.range();
    this.live = false;
    this.t = start + f * (end - start);
    this.emit();
  }

  togglePlay() {
    if (this.live) {
      this.live = false;
      this.t = this.range().start;
      this.playing = true;
    } else {
      if (!this.playing && this.span === 'event' && this.t >= this.event.end) this.t = this.event.start;
      this.playing = !this.playing;
    }
    this.emit();
  }

  fraction() {
    if (this.live) return 1;
    const { start, end } = this.range();
    return Math.min(1, Math.max(0, (this.t - start) / (end - start)));
  }

  tick(dt) {
    if (this.live || !this.playing) return;
    this.t += dt * 1000 * this.speed;
    const { end } = this.range();
    if (this.t >= end) {
      if (this.span === 'event') { this.t = end; this.playing = false; this.emit(); }
      else this.goLive();
    }
  }
}
