// Interfaz: reloj, contadores, tooltip, avisos discretos y pantalla de carga.
const $ = (id) => document.getElementById(id);

const sources = new Map(); // id -> { ok, name }
const toastTimers = new Map();

export const ui = {
  set(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  },

  // --- Reloj UTC -----------------------------------------------------------
  startClock() {
    const time = $('utc-time'), date = $('utc-date'), local = $('local-time');
    const fDate = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const fLocal = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
    const tick = () => {
      const d = new Date();
      time.textContent = d.toISOString().slice(11, 19);
      date.textContent = fDate.format(d);
      local.textContent = `Tu hora: ${fLocal.format(d)}`;
    };
    tick();
    setInterval(tick, 1000);
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
