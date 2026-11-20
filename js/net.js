// fetch con timeout: si una API no responde, la capa lo trata como fallo y sigue.
export async function fetchJSON(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
export function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'hace unos segundos';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m && h < 6 ? `hace ${h} h ${m} min` : rtf.format(-Math.round(s / 3600), 'hour');
  }
  return rtf.format(-Math.round(s / 86400), 'day');
}
