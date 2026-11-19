// VIRTUAL MEETINGS — available once an RFQ has been shared between a buyer and a supplier.
// Flow: Requested → (other party accepts → Coordinated) → link added (Zoom / Teams / Google Meet) → Confirmed → Completed
//       Either side can propose a new time (Rescheduled), which goes back to the other party.
const router = require('express').Router();
const { all, get, run, notifyCompany, notifyAdmins } = require('../lib/db');
const H = require('../lib/helpers');
const TZ = require('../lib/tz');

const PLATFORMS = { zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet', other: 'Other / in person' };
const PURPOSES = ['Technical discussion', 'Commercial negotiation', 'Drawing / specification clarification', 'Production feasibility', 'Sample / FAI review', 'Quality & audit planning', 'PO kick-off', 'Other'];

// RFQs where this company may meet the other party (RFQ has been shared with the supplier)
function partners(companyId) {
  const shared = `(r.sourcing_type != 'confidential' AND i.status != 'proposed') OR i.released = 1
                  OR EXISTS (SELECT 1 FROM nda_agreements n WHERE n.requirement_id=r.id AND n.supplier_company_id=i.supplier_company_id AND n.status='signed_both')`;
  const asBuyer = all(`SELECT r.id rid, r.ref, r.title, c.id cid, c.name FROM rfq_invites i JOIN requirements r ON r.id=i.requirement_id
      JOIN companies c ON c.id=i.supplier_company_id WHERE r.buyer_company_id=? AND r.status IN ('open','awarded','closed') AND (${shared}) ORDER BY r.id DESC`, companyId);
  const asSupplier = all(`SELECT r.id rid, r.ref, r.title, c.id cid, c.name, r.confidential, r.sourcing_type FROM rfq_invites i JOIN requirements r ON r.id=i.requirement_id
      JOIN companies c ON c.id=r.buyer_company_id WHERE i.supplier_company_id=? AND r.status IN ('open','awarded','closed') AND (${shared}) ORDER BY r.id DESC`, companyId);
  // legacy "confidential" standard RFQs keep the buyer masked
  for (const p of asSupplier) if (p.confidential && p.sourcing_type !== 'confidential') p.name = 'Confidential buyer';
  return [...asBuyer, ...asSupplier];
}

const party = (m, cid) => m.requester_company_id === cid || m.with_company_id === cid;
const otherOf = (m, cid) => (m.requester_company_id === cid ? m.with_company_id : m.requester_company_id);
// "Create meeting" shortcuts that open the chosen platform pre-filled where the platform supports it
function quickLinks(m) {
  const start = new Date(m.start_utc), end = new Date(start.getTime() + m.duration_min * 60000);
  const subject = `${m.ref || 'TradeWind'} · ${m.purpose}${m.rfq_ref ? ' (' + m.rfq_ref + ')' : ''}`;
  const g = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return {
    teams: `https://teams.microsoft.com/l/meeting/new?subject=${encodeURIComponent(subject)}&startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}&content=${encodeURIComponent(m.description || '')}`,
    zoom: 'https://zoom.us/meeting/schedule',
    meet: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(subject)}&dates=${g(start)}/${g(end)}&details=${encodeURIComponent((m.description || '') + '\n\nAdd Google Meet video conferencing, save, then paste the Meet link back into TradeWind.')}`,
  };
}
const platformOf = (link, fallback) => /zoom\./i.test(link || '') ? 'zoom' : /teams\.(microsoft|live)\./i.test(link || '') ? 'teams' : /meet\.google\./i.test(link || '') ? 'meet' : link ? 'other' : fallback;
const safeLink = (u) => /^https:\/\/[^\s<>"]+$/i.test(String(u || '').trim()) ? String(u).trim() : null;

function loadMeetings(where, ...p) {
  return all(`SELECT m.*, a.name requester, b.name with_name, r.ref rfq_ref, r.title rfq_title, r.confidential, r.sourcing_type, r.buyer_company_id, u.name requested_by
      FROM meetings m JOIN companies a ON a.id=m.requester_company_id JOIN companies b ON b.id=m.with_company_id
      LEFT JOIN requirements r ON r.id=m.requirement_id LEFT JOIN users u ON u.id=m.requester_user_id
      WHERE ${where} ORDER BY CASE m.status WHEN 'completed' THEN 2 WHEN 'cancelled' THEN 3 ELSE 1 END, m.start_utc`, ...p);
}

router.get('/meetings', H.requireLogin, (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin/meetings');
  const me = req.company.id;
  const meetings = loadMeetings('m.requester_company_id=? OR m.with_company_id=?', me, me);
  for (const m of meetings) {
    m.other = m.requester_company_id === me ? m.with_name : m.requester;
    if (m.confidential && m.sourcing_type !== 'confidential' && m.buyer_company_id !== me) m.other = 'Confidential buyer';
    m.myTurn = ['requested', 'rescheduled'].includes(m.status) && m.last_action_company_id !== me;
  }
  const pairs = partners(me);
  const pre = req.query.rfq && req.query.with ? `${req.query.rfq}:${req.query.with}` : '';
  res.render('meetings', { title: 'Meetings', meetings, pairs, pre, PLATFORMS, PURPOSES, zones: TZ.ZONES, TZ, quickLinks,
    myTz: TZ.validTz(req.user.timezone), today: new Date().toISOString().slice(0, 10) });
});

router.post('/meetings', H.requireLogin, (req, res) => {
  const v = req.body; const me = req.company.id;
  const [rid, cid] = String(v.pair || '').split(':').map(Number);
  const ok = partners(me).find(p => p.rid === rid && p.cid === cid);
  if (!ok) { H.flash(req, 'error', 'Choose an RFQ and the company you want to meet. Meetings are available once the RFQ is shared.'); return res.redirect('/meetings'); }
  const tz = TZ.validTz(v.timezone);
  const start = TZ.zonedToUtc(v.date, v.time, tz);
  if (!start || isNaN(start) || start < new Date()) { H.flash(req, 'error', 'Please choose a valid future date and time.'); return res.redirect('/meetings'); }
  const id = run(`INSERT INTO meetings(requirement_id,requester_company_id,requester_user_id,with_company_id,purpose,description,start_utc,local_date,local_time,timezone,
      duration_min,alt_slot,mode,platform,location,link,status,last_action_company_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'requested', ?)`,
    rid, me, req.user.id, cid, v.purpose || 'Technical discussion', v.description || '', start.toISOString(), v.date, v.time, tz,
    Math.min(480, Math.max(15, Number(v.duration_min) || 60)), v.alt_slot || '', v.mode === 'in_person' ? 'in_person' : 'online',
    safeLink(v.link) ? platformOf(safeLink(v.link)) : (PLATFORMS[v.platform] ? v.platform : 'zoom'), v.location || '', safeLink(v.link), me).lastInsertRowid;
  run('UPDATE meetings SET ref=? WHERE id=?', 'MTG-' + (1000 + Number(id)), id);
  notifyCompany(cid, `Meeting request (${ok.ref}): ${v.purpose} — ${TZ.fmt(start, tz)}`, '/meetings#m' + id);
  notifyAdmins(`Meeting requested on ${ok.ref}`, '/admin/meetings');
  H.flash(req, 'success', 'Meeting requested. The other party will accept or propose a new time; TradeWind helps coordinate time zones.');
  res.redirect('/meetings#m' + id);
});

router.post('/meetings/:id/:action(accept|reschedule|link|complete|cancel)', H.requireLogin, (req, res) => {
  const m = get('SELECT * FROM meetings WHERE id=?', req.params.id);
  const admin = req.user.role === 'admin';
  const me = req.user.company_id;
  if (!m || (!admin && !party(m, me))) return res.redirect('/meetings');
  const back = admin ? '/admin/meetings' : '/meetings#m' + m.id;
  const a = req.params.action; const v = req.body;
  const tellOthers = (text) => { for (const c of [m.requester_company_id, m.with_company_id]) if (c !== me) notifyCompany(c, text, '/meetings#m' + m.id); };

  if (a === 'accept' && ['requested', 'rescheduled'].includes(m.status) && (admin || m.last_action_company_id !== me)) {
    const link = safeLink(v.link) || m.link;
    run("UPDATE meetings SET status=?, link=?, platform=?, last_action_company_id=?, updated_at=datetime('now') WHERE id=?", link ? 'confirmed' : 'coordinated', link, platformOf(link, m.platform), me, m.id);
    tellOthers(link ? `Meeting ${m.ref} confirmed — join link available` : `Meeting ${m.ref} accepted — meeting link to follow`);
  } else if (a === 'reschedule' && !['completed', 'cancelled'].includes(m.status)) {
    const tz = TZ.validTz(v.timezone || m.timezone);
    const start = TZ.zonedToUtc(v.date, v.time, tz);
    if (!start || isNaN(start) || start < new Date()) { H.flash(req, 'error', 'Please choose a valid future date and time.'); return res.redirect(back); }
    run("UPDATE meetings SET status='rescheduled', start_utc=?, local_date=?, local_time=?, timezone=?, last_action_company_id=?, updated_at=datetime('now') WHERE id=?",
      start.toISOString(), v.date, v.time, tz, me, m.id);
    tellOthers(`New time proposed for ${m.ref}: ${TZ.fmt(start, tz)}`);
  } else if (a === 'link' && !['completed', 'cancelled'].includes(m.status)) {
    const link = safeLink(v.link);
    if (!link) { H.flash(req, 'error', 'Paste a valid https:// meeting link (Zoom, Teams, Google Meet…).'); return res.redirect(back); }
    const status = ['coordinated', 'confirmed'].includes(m.status) || admin ? 'confirmed' : m.status;
    run("UPDATE meetings SET link=?, platform=?, status=?, updated_at=datetime('now') WHERE id=?", link, platformOf(link, m.platform), status, m.id);
    tellOthers(status === 'confirmed' ? `Meeting ${m.ref} confirmed — join link added` : `Meeting link added to ${m.ref}`);
  } else if (a === 'complete' && ['confirmed', 'coordinated'].includes(m.status)) {
    run("UPDATE meetings SET status='completed', minutes=?, updated_at=datetime('now') WHERE id=?", v.minutes || '', m.id);
    tellOthers(`Meeting ${m.ref} marked completed — minutes recorded`);
  } else if (a === 'cancel' && !['completed', 'cancelled'].includes(m.status)) {
    run("UPDATE meetings SET status='cancelled', updated_at=datetime('now') WHERE id=?", m.id);
    tellOthers(`Meeting ${m.ref} was cancelled`);
  }
  res.redirect(back);
});

// Add-to-calendar (.ics) — works with Outlook, Google Calendar, Apple Calendar
router.get('/meetings/:id/calendar.ics', H.requireLogin, (req, res) => {
  const m = get('SELECT m.*, r.ref rfq_ref FROM meetings m LEFT JOIN requirements r ON r.id=m.requirement_id WHERE m.id=?', req.params.id);
  if (!m || (req.user.role !== 'admin' && !party(m, req.user.company_id))) return res.sendStatus(404);
  const f = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(new Date(m.start_utc).getTime() + m.duration_min * 60000);
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TradeWind Co.//Meetings//EN', 'BEGIN:VEVENT',
    `UID:${m.ref}@tradewind`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(m.start_utc)}`, `DTEND:${f(end)}`,
    `SUMMARY:${esc(`${m.ref} · ${m.purpose} (${m.rfq_ref || 'TradeWind'})`)}`,
    `DESCRIPTION:${esc((m.description || '') + (m.link ? '\nJoin: ' + m.link : ''))}`,
    `LOCATION:${esc(m.link || m.location || 'Online')}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${m.ref}.ics"` });
  res.send(ics);
});

module.exports = router;
module.exports.loadMeetings = loadMeetings;
module.exports.PLATFORMS = PLATFORMS;
module.exports.quickLinks = quickLinks;
