export const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const STATUS = { pending: 'ממתין לאישור', approved: 'אושר', rejected: 'נדחה' };

/** Tiny DOM builder: h('p', { class: 'x' }, 'text', child) - text is never parsed as HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const todayIL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

export function prettyDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `יום ${DAYS[dow]}, ${d} ב${MONTHS[m - 1]} ${y}`;
}
export const prettyTime = (b) => (b.allDay ? 'כל היום' : `${b.from}–${b.to}`);
export const money = (n) => `₪${Number(n).toLocaleString('he-IL')}`;

export async function api(path, { method = 'GET', body, password } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(password ? { 'X-Admin-Password': password } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'משהו השתבש, נסו שוב'), { status: res.status });
  return data;
}

export function bookingCard(b, extra = []) {
  return h('article', { class: 'card item' },
    h('div', { class: 'item-top' },
      h('div', {},
        h('h3', { class: 'item-name' }, b.name),
        h('p', { class: 'item-when' }, `${prettyDate(b.date)} · ${prettyTime(b)}`)),
      h('span', { class: `pill ${b.status}` }, STATUS[b.status])),
    h('div', { class: 'facts' },
      b.hourlyRate != null && h('span', { class: 'fact' }, 'שכר שעתי: ', h('b', {}, money(b.hourlyRate))),
      b.eventRate != null && h('span', { class: 'fact' }, 'שכר פר אירוע: ', h('b', {}, money(b.eventRate)))),
    b.notes && h('p', { class: 'note' }, b.notes),
    extra);
}
