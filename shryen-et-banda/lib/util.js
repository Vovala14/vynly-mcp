import { timingSafeEqual, createHash, createHmac } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return safeEqual(String(req.headers['x-admin-password'] || ''), expected);
}

export function safeEqual(given, expected) {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Secret for the calendar feed URL. Derived from the admin password, so it
 * needs no extra configuration and changing the password revokes old links.
 */
export function calendarToken() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  return createHmac('sha256', password).update('calendar-feed').digest('hex').slice(0, 40);
}

export function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'סיסמה שגויה');
}

/** Today's date (YYYY-MM-DD) in Israel. */
export function todayIL() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export function overlaps(a, b) {
  if (a.date !== b.date) return false;
  if (a.allDay || b.allDay) return true;
  return toMin(a.from) < toMin(b.to) && toMin(b.from) < toMin(a.to);
}

export function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'משהו השתבש, נסו שוב' });
    }
  };
}
