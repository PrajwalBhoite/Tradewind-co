// Integrated buyer–supplier messaging with contact masking until a deal is awarded
const router = require('express').Router();
const { all, get, run, setting, notifyCompany } = require('../lib/db');
const H = require('../lib/helpers');

router.use(['/messages', '/messages/*'], H.requireLogin);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/g;
function maskContacts(text) { return text.replace(EMAIL, '[contact hidden]').replace(PHONE, '[contact hidden]'); }

// Parties may exchange direct contacts once an RFQ between them is awarded
function dealDone(a, b) {
  return !!get(`SELECT 1 x FROM quotations q JOIN requirements r ON r.id=q.requirement_id WHERE q.status='awarded'
                AND ((r.buyer_company_id=? AND q.supplier_company_id=?) OR (r.buyer_company_id=? AND q.supplier_company_id=?))`, a, b, b, a);
}

function displayName(t, viewerCompanyId, otherId, otherName) {
  // Hide a confidential buyer's identity from the supplier until shortlisted
  if (t.requirement_id) {
    const r = get('SELECT * FROM requirements WHERE id=?', t.requirement_id);
    if (r && r.confidential && r.buyer_company_id === otherId) {
      const q = get('SELECT status FROM quotations WHERE requirement_id=? AND supplier_company_id=?', r.id, viewerCompanyId);
      if (!q || !['shortlisted', 'awarded'].includes(q.status)) return 'Confidential buyer (' + (get('SELECT country FROM companies WHERE id=?', otherId).country || '') + ')';
    }
  }
  return otherName;
}

router.get('/messages', (req, res) => {
  const me = req.user.company_id;
  const rows = all(`SELECT t.*, ca.name a_name, cb.name b_name,
        (SELECT body FROM messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) last_body
        FROM threads t JOIN companies ca ON ca.id=t.company_a JOIN companies cb ON cb.id=t.company_b
        WHERE t.company_a=? OR t.company_b=? ORDER BY t.updated_at DESC`, me, me);
  for (const t of rows) {
    const otherId = t.company_a === me ? t.company_b : t.company_a;
    t.other = displayName(t, me, otherId, t.company_a === me ? t.b_name : t.a_name);
  }
  res.render('messages', { title: 'Messages', rows });
});

router.get('/messages/:id', (req, res) => {
  const t = get('SELECT * FROM threads WHERE id=?', req.params.id);
  const me = req.user.company_id;
  if (!t || (t.company_a !== me && t.company_b !== me && req.user.role !== 'admin')) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const otherId = t.company_a === me ? t.company_b : t.company_a;
  const other = get('SELECT * FROM companies WHERE id=?', otherId);
  const name = displayName(t, me, otherId, other.name);
  const msgs = all(`SELECT m.*, u.name sender FROM messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.thread_id=? ORDER BY m.id`, t.id);
  for (const m of msgs) if (m.sender_company_id !== me && name !== other.name) m.sender = 'Buyer representative';
  const req_ = t.requirement_id ? get('SELECT id, ref, title, buyer_company_id FROM requirements WHERE id=?', t.requirement_id) : null;
  res.render('thread', { title: t.subject, t, msgs, otherName: name, other, masked: name !== other.name, reqInfo: req_ });
});

router.post('/messages/:id', (req, res) => {
  const t = get('SELECT * FROM threads WHERE id=?', req.params.id);
  const me = req.user.company_id;
  if (!t || (t.company_a !== me && t.company_b !== me)) return res.redirect('/messages');
  let body = String(req.body.body || '').trim().slice(0, 5000);
  if (!body) return res.redirect('/messages/' + t.id);
  const otherId = t.company_a === me ? t.company_b : t.company_a;
  if (setting('mask_contacts', '1') === '1' && !dealDone(me, otherId)) body = maskContacts(body);
  run('INSERT INTO messages(thread_id,sender_user_id,sender_company_id,body) VALUES(?,?,?,?)', t.id, req.user.id, me, body);
  run("UPDATE threads SET updated_at=datetime('now') WHERE id=?", t.id);
  notifyCompany(otherId, `New message: ${t.subject}`, `/messages/${t.id}`);
  res.redirect('/messages/' + t.id + '#bottom');
});

// Start (or continue) a conversation with a company, optionally about an RFQ or product
router.post('/messages/start/new', (req, res) => {
  const me = req.user.company_id;
  const to = Number(req.body.to_company_id);
  const target = get("SELECT * FROM companies WHERE id=? AND status='active'", to);
  if (!target || to === me) return res.redirect('back');
  const reqId = req.body.requirement_id ? Number(req.body.requirement_id) : null;
  const prodId = req.body.product_id ? Number(req.body.product_id) : null;
  if (reqId) { // must be a party to that RFQ
    const r = get('SELECT * FROM requirements WHERE id=?', reqId);
    const party = r && (r.buyer_company_id === me || get('SELECT 1 x FROM rfq_invites WHERE requirement_id=? AND supplier_company_id=?', reqId, me));
    if (!party) return res.redirect('back');
  }
  let t = get(`SELECT * FROM threads WHERE ((company_a=? AND company_b=?) OR (company_a=? AND company_b=?)) AND COALESCE(requirement_id,0)=? AND COALESCE(product_id,0)=?`,
    me, to, to, me, reqId || 0, prodId || 0);
  if (!t) {
    const subject = String(req.body.subject || 'Business enquiry').slice(0, 150);
    const id = run('INSERT INTO threads(requirement_id,product_id,company_a,company_b,subject) VALUES(?,?,?,?,?)', reqId, prodId, me, to, subject).lastInsertRowid;
    t = { id };
  }
  if (req.body.body && req.body.body.trim()) {
    let body = req.body.body.trim().slice(0, 5000);
    if (setting('mask_contacts', '1') === '1' && !dealDone(me, to)) body = maskContacts(body);
    run('INSERT INTO messages(thread_id,sender_user_id,sender_company_id,body) VALUES(?,?,?,?)', t.id, req.user.id, me, body);
    run("UPDATE threads SET updated_at=datetime('now') WHERE id=?", t.id);
    notifyCompany(to, `New enquiry from ${req.company.name}`, `/messages/${t.id}`);
  }
  res.redirect('/messages/' + t.id);
});

module.exports = router;
