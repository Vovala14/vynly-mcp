import { MONTHS, h, iso, todayIL, prettyDate, prettyTime, api, bookingCard } from '/common.js';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const dlg = $('dlg');
const form = $('form');
const MINE_KEY = 'banda.myBookings';

const today = todayIL();
const [ty, tm] = today.split('-').map(Number);
let view = { y: ty, m: tm - 1 };
let bookings = [];

const myIds = () => {
  try { return JSON.parse(localStorage.getItem(MINE_KEY)) || []; } catch { return []; }
};
const saveId = (id) => {
  try { localStorage.setItem(MINE_KEY, JSON.stringify([...myIds(), id].slice(-50))); } catch { /* private mode */ }
};

function render() {
  const { y, m } = view;
  $('calTitle').textContent = `${MONTHS[m]} ${y}`;
  $('prevBtn').disabled = y === ty && m === tm - 1;

  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(h('div', { class: 'day blank' }));

  for (let d = 1; d <= count; d++) {
    const date = iso(y, m, d);
    const dayBookings = bookings.filter((b) => b.date === date);
    const approved = dayBookings.filter((b) => b.status === 'approved');
    const pending = dayBookings.filter((b) => b.status === 'pending');
    const past = date < today;
    const full = approved.some((b) => b.allDay);

    const tags = [];
    if (approved.length) tags.push(h('span', { class: 'tag ok' }, full ? 'משוריין' : `משוריין ${approved.map(prettyTime).join(', ')}`));
    if (pending.length) tags.push(h('span', { class: 'tag wait' }, pending.length > 1 ? `${pending.length} ממתינות` : 'ממתינה'));

    const label = [prettyDate(date), full ? 'משוריין כל היום' : approved.length ? 'משוריין חלקית' : 'פנוי',
      pending.length ? `${pending.length} בקשות ממתינות` : ''].filter(Boolean).join(', ');

    cells.push(h('button', {
      type: 'button',
      class: ['day', date === today && 'today', approved.length && 'has-ok', pending.length && 'has-wait'].filter(Boolean).join(' '),
      disabled: past || full,
      'aria-label': label,
      onclick: () => openForm(date),
    }, h('span', { class: 'n' }, String(d)), h('span', { class: 'tags' }, tags)));
  }
  grid.replaceChildren(...cells);
}

function renderMine(mine) {
  $('mineSection').hidden = mine.length === 0;
  mine.sort((a, b) => (a.date + (a.from || '')).localeCompare(b.date + (b.from || '')));
  $('mine').replaceChildren(...mine.map((b) => bookingCard(b)));
}

async function load() {
  try {
    const ids = myIds();
    const data = await api(`/api/bookings${ids.length ? `?ids=${ids.join(',')}` : ''}`);
    bookings = data.bookings;
    renderMine(data.mine);
  } catch (err) {
    console.error(err);
  }
  render();
}

function openForm(date) {
  const keep = ['name', 'phone', 'email'].map((k) => [k, form.elements[k].value]);
  form.reset();
  for (const [k, v] of keep) form.elements[k].value = v;
  form.elements.date.value = date;
  form.elements.date.min = today;
  $('dlgSub').textContent = prettyDate(date);
  $('formError').textContent = '';
  $('payBox').classList.remove('invalid');
  $('timeRow').hidden = false;
  form.hidden = false;
  $('done').hidden = true;
  dlg.showModal();
  form.elements.name.focus();
}

form.elements.allDay.addEventListener('change', (e) => { $('timeRow').hidden = e.target.checked; });
form.elements.date.addEventListener('change', (e) => { if (e.target.value) $('dlgSub').textContent = prettyDate(e.target.value); });
$('closeBtn').addEventListener('click', () => dlg.close());
$('doneBtn').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

function fail(message, focusEl) {
  $('formError').textContent = message;
  focusEl?.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  $('payBox').classList.remove('invalid');
  $('formError').textContent = '';

  const body = {
    name: f.name.value.trim(),
    phone: f.phone.value.trim(),
    email: f.email.value.trim(),
    date: f.date.value,
    allDay: f.allDay.checked,
    from: f.from.value,
    to: f.to.value,
    hourlyRate: f.hourlyRate.value,
    eventRate: f.eventRate.value,
    notes: f.notes.value.trim(),
    website: f.website.value,
  };
  if (!body.name) return fail('איך קוראים לך? חסר שם המזמין.', f.name);
  const digits = body.phone.replace(/\D/g, '');
  if (!body.phone) return fail('חסר טלפון לחזרה.', f.phone);
  if (!/^\+?[\d\s()-]+$/.test(body.phone) || digits.length < 9 || digits.length > 15) return fail('מספר הטלפון לא תקין.', f.phone);
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return fail('כתובת המייל לא תקינה.', f.email);
  if (!body.date) return fail('חסר תאריך.', f.date);
  if (body.date < today) return fail('אי אפשר לשריין תאריך שעבר.', f.date);
  if (!body.allDay) {
    if (!body.from || !body.to) return fail('בחרו שעות התחלה וסיום, או סמנו "כל היום".', f.from);
    if (body.from >= body.to) return fail('שעת הסיום חייבת להיות אחרי שעת ההתחלה.', f.to);
  }
  if (!(Number(body.hourlyRate) > 0) && !(Number(body.eventRate) > 0)) {
    $('payBox').classList.add('invalid');
    return fail('חובה למלא שכר שעתי או שכר פר אירוע.', f.hourlyRate);
  }

  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = 'שולח…';
  try {
    const { booking } = await api('/api/bookings', { method: 'POST', body });
    if (booking) saveId(booking.id);
    $('doneText').textContent = `${prettyDate(body.date)}, ${prettyTime(body)}. הסטטוס יופיע כאן בעמוד תחת "הבקשות שלי".`;
    form.hidden = true;
    $('done').hidden = false;
    $('doneBtn').focus();
    load();
  } catch (err) {
    fail(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'שלח בקשה לבנדה';
  }
});

function shift(delta) {
  const d = new Date(Date.UTC(view.y, view.m + delta, 1));
  view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  render();
}
$('prevBtn').addEventListener('click', () => shift(-1));
$('nextBtn').addEventListener('click', () => shift(1));
$('todayBtn').addEventListener('click', () => { view = { y: ty, m: tm - 1 }; render(); });

render();
load();
