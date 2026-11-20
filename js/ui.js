// Interfaz: reloj, contadores, tooltip, avisos discretos y pantalla de carga.
const $ = (id) => document.getElementById(id);

const sources = new Map(); // id -> { ok, name }
const toastTimers = new Map();

export const ui = {
  set(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  },

  // --- Reloj UTC (sigue a la repetición si está activa) -----------------
  startClock(time) {
    const fDate = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const fLocal = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
    const tick = () => {
      const d = new Date(time.now());
      this.set('utc-time', d.toISOString().slice(11, 19));
      this.set('utc-date', fDate.format(d));
      this.set('local-time', time.live ? `Tu hora: ${fLocal.format(d)}` : 'Repetición en curso');
      this.set('clock-label', time.live ? 'Hora UTC' : 'Repetición · UTC');
      document.body.classList.toggle('replay', !time.live);
      this.updateTimeline(time);
    };
    tick();
    setInterval(tick, 100);
  },

  // --- Línea de tiempo -------------------------------------------------
  bindTimeline(time) {
    const range = $('tl-range'), play = $('tl-play'), live = $('tl-live');
    range.addEventListener('input', () => time.seek(Number(range.value) / 1000));
    play.addEventListener('click', () => time.togglePlay());
    live.addEventListener('click', () => time.goLive());
    time.onChange(() => this.updateTimeline(time));
    this.updateTimeline(time);
  },
  updateTimeline(time) {
    const range = $('tl-range');
    if (!range) return;
    const f = time.fraction();
    if (document.activeElement !== range) range.value = String(Math.round(f * 1000));
    range.style.setProperty('--p', `${(f * 100).toFixed(2)}%`);
    const playing = !time.live && time.playing;
    const play = $('tl-play');
    play.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir las últimas 24 h');
    play.dataset.state = playing ? 'pause' : 'play';
    $('tl-live').setAttribute('aria-pressed', String(time.live));
    let txt = 'En directo';
    if (!time.live) {
      const mins = Math.round((Date.now() - time.now()) / 60000);
      const h = Math.floor(mins / 60), m = mins % 60;
      txt = `−${h ? `${h} h ` : ''}${m} min`;
    }
    this.set('tl-label', txt);
  },

  // --- Capas activables -----------------------------------------------
  bindToggles(handlers) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('planeta.capas') || '{}'); } catch { /* sin almacenamiento */ }
    for (const [id, fn] of Object.entries(handlers)) {
      const input = document.querySelector(`[data-layer="${id}"]`);
      if (!input) continue;
      if (typeof saved[id] === 'boolean') input.checked = saved[id];
      fn(input.checked);
      input.addEventListener('change', () => {
        fn(input.checked);
        saved[id] = input.checked;
        try { localStorage.setItem('planeta.capas', JSON.stringify(saved)); } catch { /* sin almacenamiento */ }
      });
    }
  },

  // --- Estado de las fuentes de datos -----------------------------------
  registerSource(id, name) {
    sources.set(id, { ok: null, name });
    this.renderSources();
  },
  sourceOk(id) {
    const s = sources.get(id);
    if (!s) return;
    const wasBad = s.ok === false;
    s.ok = true;
    this.renderSources();
    if (wasBad) this.toast(`${s.name}: conexión recuperada`, 'ok', id);
  },
  sourceError(id, msg) {
    const s = sources.get(id);
    if (!s) return;
    const first = s.ok !== false;
    s.ok = false;
    this.renderSources();
    if (first) this.toast(msg, 'warn', id);
  },
  renderSources() {
    const el = $('sources');
    if (!el) return;
    el.innerHTML = [...sources.values()]
      .map((s) => `<span class="src ${s.ok === false ? 'bad' : s.ok ? 'ok' : ''}" title="${s.ok === false ? 'Sin conexión' : 'En directo'}">${s.name}</span>`)
      .join('');
  },

  toast(msg, kind = 'info', key = msg) {
    const box = $('toasts');
    let el = box.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.dataset.key = key;
      box.appendChild(el);
    }
    el.dataset.kind = kind;
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimers.get(key));
    toastTimers.set(key, setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, kind === 'warn' ? 8000 : 6000));
  },

  // --- Tooltip -------------------------------------------------------------
  showTooltip(html, x, y) {
    const tt = $('tooltip');
    if (tt.dataset.html !== html) {
      tt.innerHTML = html;
      tt.dataset.html = html;
    }
    tt.classList.add('show');
    const r = tt.getBoundingClientRect();
    const pad = 12;
    let left = x + 16, top = y + 16;
    if (left + r.width > innerWidth - pad) left = x - r.width - 16;
    if (top + r.height > innerHeight - pad) top = y - r.height - 16;
    tt.style.transform = `translate(${Math.max(pad, left)}px, ${Math.max(pad, top)}px)`;
  },
  hideTooltip() {
    $('tooltip').classList.remove('show');
  },

  // --- Botón seguir ISS --------------------------------------------------
  onFollow(fn) {
    $('btn-follow').addEventListener('click', () => fn());
  },
  setFollow(on) {
    const b = $('btn-follow');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.btn-text').textContent = on ? 'Siguiendo a la ISS' : 'Seguir a la ISS';
  },

  // --- Carga -------------------------------------------------------------
  setProgress(p) {
    $('loader-bar').style.transform = `scaleX(${p})`;
    $('loader-pct').textContent = `${Math.round(p * 100)}%`;
  },
  hideLoader() {
    document.body.classList.add('ready');
    setTimeout(() => $('loader')?.remove(), 1200);
  },
  fatal(msg) {
    $('loader-status').textContent = msg;
    $('loader').classList.add('error');
  },
};
