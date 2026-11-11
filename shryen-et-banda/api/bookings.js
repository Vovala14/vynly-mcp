import { randomUUID } from 'node:crypto';
import { listBookings, mutate } from '../lib/store.js';
import { HttpError, requireAdmin, overlaps, todayIL, wrap } from '../lib/util.js';

const MAX_BOOKINGS = 3000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function rate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new HttpError(400, `${label} לא תקין`);
  return Math.round(n * 100) / 100;
}

function parseBooking(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'בקשה לא תקינה');
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'חסר שם המזמין');
  if (name.length > 80) throw new HttpError(400, 'שם המזמין ארוך מדי');

  const date = String(body.date || '');
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new HttpError(400, 'תאריך לא תקין');
  if (date < todayIL()) throw new HttpError(400, 'אי אפשר לשריין תאריך שעבר');

  const hourlyRate = rate(body.hourlyRate, 'שכר שעתי');
  const eventRate = rate(body.eventRate, 'שכר פר אירוע');
  if (hourlyRate === null && eventRate === null) throw new HttpError(400, 'חובה למלא שכר שעתי או שכר פר אירוע');

  const allDay = body.allDay === true;
  let from = null;
  let to = null;
  if (!allDay) {
    from = String(body.from || '');
    to = String(body.to || '');
    if (!TIME.test(from) || !TIME.test(to)) throw new HttpError(400, 'חובה לבחור שעות או לסמן "כל היום"');
    if (from >= to) throw new HttpError(400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה');
  }

  const notes = String(body.notes || '').trim();
  if (notes.length > 1000) throw new HttpError(400, 'ההערות ארוכות מדי');

  return { name, date, allDay, from, to, hourlyRate, eventRate, notes };
}

const publicView = ({ date, allDay, from, to, status }) => ({ date, allDay, from, to, status });

export default wrap(async (req, res) => {
  if (req.method === 'GET') {
    const all = await listBookings();
    if (req.query.admin !== undefined) {
      requireAdmin(req);
      return res.json({ bookings: all });
    }
    // Visitors see only when Banda is taken, never who booked or for how much.
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 50);
    return res.json({
      bookings: all.filter((b) => b.status !== 'rejected').map(publicView),
      mine: all.filter((b) => ids.includes(b.id)),
    });
  }

  if (req.method === 'POST') {
    if (req.body?.website) return res.status(201).json({ booking: null }); // honeypot
    const data = parseBooking(req.body);
    const booking = await mutate((bookings) => {
      if (bookings.length >= MAX_BOOKINGS) throw new HttpError(503, 'היומן מלא כרגע, נסו מאוחר יותר');
      if (bookings.some((b) => b.status === 'approved' && overlaps(b, data))) {
        throw new HttpError(409, 'בנדה כבר משוריין בזמן הזה');
      }
      const created = { id: randomUUID(), ...data, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null };
      return { bookings: [...bookings, created], value: created };
    });
    return res.status(201).json({ booking });
  }

  if (req.method === 'PATCH') {
    requireAdmin(req);
    const { id, status } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) throw new HttpError(400, 'סטטוס לא תקין');
    const booking = await mutate((bookings) => {
      const target = bookings.find((b) => b.id === id);
      if (!target) throw new HttpError(404, 'הבקשה לא נמצאה');
      if (status === 'approved' && bookings.some((b) => b.id !== id && b.status === 'approved' && overlaps(b, target))) {
        throw new HttpError(409, 'יש כבר שריון מאושר שמתנגש עם הבקשה הזו');
      }
      const updated = { ...target, status, decidedAt: status === 'pending' ? null : new Date().toISOString() };
      return { bookings: bookings.map((b) => (b.id === id ? updated : b)), value: updated };
    });
    return res.json({ booking });
  }

  if (req.method === 'DELETE') {
    requireAdmin(req);
    const id = String(req.query.id || '');
    await mutate((bookings) => {
      if (!bookings.some((b) => b.id === id)) throw new HttpError(404, 'הבקשה לא נמצאה');
      return { bookings: bookings.filter((b) => b.id !== id), value: null };
    });
    return res.json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  res.status(405).json({ error: 'Method not allowed' });
});

