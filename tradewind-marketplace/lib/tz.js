// Time-zone helpers for meeting scheduling (no external library needed)
const ZONES = [
  ['Asia/Kolkata', 'IST (UTC+05:30) India'],
  ['Asia/Dubai', 'GST (UTC+04:00) Dubai'],
  ['Asia/Riyadh', 'AST (UTC+03:00) Riyadh'],
  ['Europe/London', 'UK time — London'],
  ['Europe/Berlin', 'CET — Berlin, Paris, Madrid'],
  ['Europe/Istanbul', 'TRT (UTC+03:00) Istanbul'],
  ['Africa/Cairo', 'Egypt — Cairo'],
  ['Africa/Johannesburg', 'SAST (UTC+02:00) Johannesburg'],
  ['Africa/Lagos', 'WAT (UTC+01:00) Lagos'],
  ['Africa/Nairobi', 'EAT (UTC+03:00) Nairobi'],
  ['Asia/Dhaka', 'BST (UTC+06:00) Dhaka'],
  ['Asia/Colombo', 'Sri Lanka (UTC+05:30) Colombo'],
  ['Asia/Bangkok', 'ICT (UTC+07:00) Bangkok, Hanoi, Jakarta'],
  ['Asia/Singapore', 'SGT (UTC+08:00) Singapore, Kuala Lumpur'],
  ['Asia/Shanghai', 'CST (UTC+08:00) China'],
  ['Asia/Tokyo', 'JST (UTC+09:00) Tokyo'],
  ['Asia/Seoul', 'KST (UTC+09:00) Seoul'],
  ['Australia/Sydney', 'Australia — Sydney'],
  ['America/New_York', 'US Eastern — New York'],
  ['America/Chicago', 'US Central — Chicago'],
  ['America/Denver', 'US Mountain — Denver'],
  ['America/Los_Angeles', 'US Pacific — Los Angeles'],
  ['America/Toronto', 'Canada Eastern — Toronto'],
  ['America/Mexico_City', 'Mexico City'],
  ['America/Sao_Paulo', 'Brazil — São Paulo'],
  ['UTC', 'UTC / GMT'],
];
const VALID = new Set(ZONES.map(z => z[0]));
const validTz = (tz) => {
  if (VALID.has(tz)) return tz;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'UTC'; }
};

// offset (ms) of a time zone at a given UTC instant
function offsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
// "2026-11-26" + "10:30" in "Asia/Kolkata"  ->  Date (UTC)
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  if (!y || !m || !d) return null;
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let utc = guess - offsetMs(guess, tz);
  utc = guess - offsetMs(utc, tz); // second pass handles DST edges
  return new Date(utc);
}
function fmt(dateIso, tz) {
  const d = new Date(dateIso);
  return new Intl.DateTimeFormat('en-GB', { timeZone: validTz(tz), weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
const label = (tz) => (ZONES.find(z => z[0] === tz) || [tz, tz])[1];

module.exports = { ZONES, validTz, zonedToUtc, fmt, label };
