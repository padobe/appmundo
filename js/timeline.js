// Reloj de la escena: en directo o reproduciendo las últimas 24 h.
// Todas las capas preguntan aquí la hora en vez de usar Date.now().
const DAY = 86400000;
const REPLAY_SECONDS = 36; // 24 h se reproducen en ~36 s

export class Timeline {
  constructor() {
    this.live = true;
    this.playing = false;
    this.t = Date.now();
    this.speed = DAY / (REPLAY_SECONDS * 1000);
    this.listeners = new Set();
  }

  now() { return this.live ? Date.now() : this.t; }
  start() { return Date.now() - DAY; }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  goLive() {
    this.live = true;
    this.playing = false;
    this.emit();
  }

  /** f ∈ [0, 1] dentro de las últimas 24 h */
  seek(f) {
    if (f >= 0.999) { this.goLive(); return; }
    this.live = false;
    this.t = this.start() + f * DAY;
    this.emit();
  }

  togglePlay() {
    if (this.live) {
      this.live = false;
      this.t = this.start();
      this.playing = true;
    } else {
      this.playing = !this.playing;
    }
    this.emit();
  }

  fraction() { return this.live ? 1 : (this.t - this.start()) / DAY; }

  tick(dt) {
    if (this.live || !this.playing) return;
    this.t += dt * 1000 * this.speed;
    if (this.t >= Date.now()) this.goLive();
  }
}
