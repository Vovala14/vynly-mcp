// Read-only iCalendar feed of approved bookings, for subscribing from Apple
// Calendar (or Google/Outlook). Calendar apps can't send headers, so the feed
// is protected by a secret token in the URL instead of the admin password.
import { listBookings } from '../lib/store.js';
import { HttpError, calendarToken, safeEqual, wrap } from '../lib/util.js';

const pad = (n) => String(n).padStart(2, '0');
const compact = (date) => date.replaceAll('-', '');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

/** Israel wall-clock time -> UTC Date, DST-aware. */
function israelToUtc(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess).map((p) => [p.type, p.value]),
  );
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(guess.getTime() - (shown - guess.getTime()));
}

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

const esc = (text) => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545: lines are at most 75 bytes; continuation lines start with a space. */
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 74) {
      out.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

function toEvent(b) {
  const details = [
    `טלפון: ${b.phone || '-'}`,
    b.email && `מייל: ${b.email}`,
    b.hourlyRate != null && `שכר שעתי: ${b.hourlyRate} ₪`,
    b.eventRate != null && `שכר פר אירוע: ${b.eventRate} ₪`,
    b.notes && `\nהערות: ${b.notes}`,
  ].filter(Boolean).join('\n');

  return [
    'BEGIN:VEVENT',
    `UID:${b.id}@shryen-et-banda`,
    `DTSTAMP:${stamp(new Date(b.decidedAt || b.createdAt))}`,
    ...(b.allDay
      ? [`DTSTART;VALUE=DATE:${compact(b.date)}`, `DTEND;VALUE=DATE:${nextDay(b.date)}`]
      : [`DTSTART:${stamp(israelToUtc(b.date, b.from))}`, `DTEND:${stamp(israelToUtc(b.date, b.to))}`]),
    `SUMMARY:${esc(`שריון: ${b.name}`)}`,
    `DESCRIPTION:${esc(details)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ];
}

export default wrap(async (req, res) => {
  const expected = calendarToken();
  if (!expected || !safeEqual(String(req.query.token || ''), expected)) throw new HttpError(401, 'קישור היומן לא תקין');

  const approved = (await listBookings()).filter((b) => b.status === 'approved');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shryen-et-banda//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:שריין את בנדה',
    'X-WR-TIMEZONE:Asia/Jerusalem',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    ...approved.flatMap(toEvent),
    'END:VCALENDAR',
  ];
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="banda.ics"');
  res.status(200).send(lines.map(fold).join('\r\n') + '\r\n');
});
