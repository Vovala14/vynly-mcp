import { h, api, bookingCard, todayIL } from '/common.js';

const $ = (id) => document.getElementById(id);
const PW_KEY = 'banda.adminPassword';
const TABS = [
  { key: 'pending', label: 'ממתינות', empty: 'אין בקשות שממתינות. שקט בגזרה.' },
  { key: 'approved', label: 'מאושרות', empty: 'עוד לא אישרת אף שריון.' },
  { key: 'rejected', label: 'נדחו', empty: 'לא דחית אף בקשה.' },
];

let password = sessionStorage.getItem(PW_KEY) || '';
let bookings = [];
let calendarToken = null;
let tab = 'pending';
let toastTimer;

function toast(message) {
  $('toast').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 3500);
}

function show(loggedIn) {
  $('login').hidden = loggedIn;
  $('panel').hidden = !loggedIn;
  $('logoutBtn').hidden = !loggedIn;
  $('syncBtn').hidden = !loggedIn;
}

function logout() {
  password = '';
  sessionStorage.removeItem(PW_KEY);
  show(false);
}

async function load() {
  const data = await api('/api/bookings?admin', { password });
  bookings = data.bookings;
  calendarToken = data.calendarToken;
  render();
}

async function act(run, done) {
  try {
    await run();
    toast(done);
  } catch (err) {
    if (err.status === 401) return logout();
    toast(err.message);
  }
  await load().catch(() => {});
}

const setStatus = (b, status, done) =>
  act(() => api('/api/bookings', { method: 'PATCH', body: { id: b.id, status }, password }), done);

function actionsFor(b) {
  const btn = (cls, label, fn) => h('button', { class: `btn sm ${cls}`, type: 'button', onclick: (e) => { e.currentTarget.disabled = true; fn(); } }, label);
  const remove = btn('ghost', 'מחק', () => {
    if (confirm(`למחוק לגמרי את הבקשה של ${b.name}?`)) act(() => api(`/api/bookings?id=${b.id}`, { method: 'DELETE', password }), 'הבקשה נמחקה');
    else render();
  });
  if (b.status === 'pending') {
    return [btn('ok', 'אשר', () => setStatus(b, 'approved', `אישרת את ${b.name}`)), btn('no', 'סרב', () => setStatus(b, 'rejected', `סירבת ל${b.name}`))];
  }
  return [
    b.status === 'approved' ? btn('no', 'בטל אישור וסרב', () => setStatus(b, 'rejected', 'האישור בוטל')) : btn('ok', 'אשר בכל זאת', () => setStatus(b, 'approved', `אישרת את ${b.name}`)),
    btn('ghost', 'החזר להמתנה', () => setStatus(b, 'pending', 'הוחזר להמתנה')),
    remove,
  ];
}

function render() {
  const today = todayIL();
  const counts = Object.fromEntries(TABS.map((t) => [t.key, bookings.filter((b) => b.status === t.key).length]));
  $('tabs').replaceChildren(...TABS.map((t) =>
    h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(tab === t.key), onclick: () => { tab = t.key; render(); } },
      t.label, h('span', { class: `count ${t.key === 'pending' && counts.pending ? 'hot' : ''}` }, String(counts[t.key])))));

  const key = (b) => b.date + (b.from || '00:00');
  const items = bookings.filter((b) => b.status === tab);
  // Upcoming first (soonest on top), then past ones.
  const upcoming = items.filter((b) => b.date >= today).sort((a, b) => key(a).localeCompare(key(b)));
  const past = items.filter((b) => b.date < today).sort((a, b) => key(b).localeCompare(key(a)));

  const cards = [...upcoming, ...past].map((b) => bookingCard(b, [
    h('div', { class: 'actions' }, actionsFor(b)),
    h('small', { class: 'hint' }, `נשלח ב־${new Date(b.createdAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}${b.date < today ? ' · התאריך עבר' : ''}`),
  ]));
  $('list').replaceChildren(...(cards.length ? cards : [h('p', { class: 'empty' }, TABS.find((t) => t.key === tab).empty)]));
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  password = e.target.elements.password.value;
  $('loginError').textContent = '';
  btn.disabled = true;
  try {
    await load();
    sessionStorage.setItem(PW_KEY, password);
    e.target.reset();
    show(true);
  } catch (err) {
    password = '';
    $('loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('logoutBtn').addEventListener('click', logout);

const syncDlg = $('syncDlg');
$('syncBtn').addEventListener('click', () => {
  const path = `${location.host}/api/calendar?token=${calendarToken}`;
  $('syncLink').href = `webcal://${path}`;
  $('syncUrl').value = `${location.protocol}//${path}`;
  syncDlg.showModal();
});
$('syncClose').addEventListener('click', () => syncDlg.close());
syncDlg.addEventListener('click', (e) => { if (e.target === syncDlg) syncDlg.close(); });
$('syncUrl').addEventListener('focus', (e) => e.target.select());
$('syncCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('syncUrl').value);
    toast('הקישור הועתק');
  } catch {
    $('syncUrl').select();
    toast('סמנו את הקישור והעתיקו ידנית');
  }
});

if (password) {
  load().then(() => show(true)).catch(logout);
} else {
  show(false);
}
