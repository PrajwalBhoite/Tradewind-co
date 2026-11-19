const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { all, get, run, notifyAdmins } = require('../lib/db');
const H = require('../lib/helpers');
const { INDUSTRIES } = require('../seed');

// ---------- Dashboard (adapts to buyer / supplier / both) ----------
router.get('/dashboard', H.requireLogin, (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin');
  const c = req.company; const d = {};
  if (c.is_buyer) {
    d.reqs = all(`SELECT r.*, (SELECT COUNT(*) FROM quotations q WHERE q.requirement_id=r.id AND q.status NOT IN ('pending_review','withdrawn')) quotes,
                  (SELECT COUNT(*) FROM rfq_invites i WHERE i.requirement_id=r.id) invited
                  FROM requirements r WHERE r.buyer_company_id=? ORDER BY r.created_at DESC LIMIT 8`, c.id);
    d.buyerStats = {
      open: get("SELECT COUNT(*) n FROM requirements WHERE buyer_company_id=? AND status='open'", c.id).n,
      review: get("SELECT COUNT(*) n FROM requirements WHERE buyer_company_id=? AND status='pending_review'", c.id).n,
      quotes: get("SELECT COUNT(*) n FROM quotations q JOIN requirements r ON r.id=q.requirement_id WHERE r.buyer_company_id=? AND q.status NOT IN ('pending_review','withdrawn')", c.id).n,
      saved: get('SELECT COUNT(*) n FROM saved_suppliers WHERE buyer_company_id=?', c.id).n,
    };
    d.latestQuotes = all(`SELECT q.*, r.title, r.ref, s.name supplier FROM quotations q JOIN requirements r ON r.id=q.requirement_id
                  JOIN companies s ON s.id=q.supplier_company_id WHERE r.buyer_company_id=? AND q.status NOT IN ('pending_review','withdrawn')
                  ORDER BY q.created_at DESC LIMIT 5`, c.id);
  }
  if (c.is_supplier) {
    d.supStats = {
      products: get("SELECT COUNT(*) n FROM products WHERE company_id=?", c.id).n,
      stock: get("SELECT COUNT(*) n FROM products WHERE company_id=? AND availability='ready_stock' AND stock_qty>0", c.id).n,
      rfqs: get("SELECT COUNT(*) n FROM rfq_invites i JOIN requirements r ON r.id=i.requirement_id WHERE i.supplier_company_id=? AND r.status='open' AND i.status!='proposed' AND (r.sourcing_type!='confidential' OR i.released=1)", c.id).n,
      ndas: get("SELECT COUNT(*) n FROM nda_agreements WHERE supplier_company_id=? AND status='sent'", c.id).n,
      quotes: get('SELECT COUNT(*) n FROM quotations WHERE supplier_company_id=?', c.id).n,
      won: get("SELECT COUNT(*) n FROM quotations WHERE supplier_company_id=? AND status='awarded'", c.id).n,
      views: get('SELECT COALESCE(SUM(views),0) n FROM products WHERE company_id=?', c.id).n,
    };
    d.invites = all(`SELECT i.*, r.title, r.ref, r.quantity, r.unit, r.quote_deadline, r.delivery_country, r.confidential FROM rfq_invites i
                  JOIN requirements r ON r.id=i.requirement_id WHERE i.supplier_company_id=? AND r.status='open'
                  AND i.status!='proposed' AND (r.sourcing_type!='confidential' OR i.released=1)
                  ORDER BY i.created_at DESC LIMIT 6`, c.id);
  }
  d.threads = all(`SELECT t.*, CASE WHEN t.company_a=? THEN cb.name ELSE ca.name END other FROM threads t
                  JOIN companies ca ON ca.id=t.company_a JOIN companies cb ON cb.id=t.company_b
                  WHERE t.company_a=? OR t.company_b=? ORDER BY t.updated_at DESC LIMIT 4`, c.id, c.id, c.id);
  d.completeness = profileCompleteness(c);
  if (c.is_buyer) d.cs = all(`SELECT r.id, r.ref, r.title, r.status,
      (SELECT COUNT(*) FROM nda_agreements n WHERE n.requirement_id=r.id AND n.status='supplier_signed') to_countersign
      FROM requirements r WHERE r.buyer_company_id=? AND r.sourcing_type='confidential' AND r.status IN ('pending_review','open') ORDER BY r.created_at DESC LIMIT 5`, c.id);
  const TZ = require('../lib/tz');
  d.meetings = all(`SELECT m.*, CASE WHEN m.requester_company_id=? THEN b.name ELSE a.name END other FROM meetings m
      JOIN companies a ON a.id=m.requester_company_id JOIN companies b ON b.id=m.with_company_id
      WHERE (m.requester_company_id=? OR m.with_company_id=?) AND m.status IN ('requested','coordinated','confirmed','rescheduled')
      ORDER BY m.start_utc LIMIT 5`, c.id, c.id, c.id);
  d.tz = TZ.validTz(req.user.timezone); d.TZ = TZ;
  res.render('dashboard', { title: 'Dashboard', d });
});

function profileCompleteness(c) {
  const fields = ['description', 'address', 'website', 'reg_number', 'tax_id', 'year_established', 'industries', 'logo'];
  if (c.is_supplier) fields.push('capabilities', 'certifications', 'production_capacity');
  const done = fields.filter(f => c[f]).length + (c.verification_status === 'verified' ? 2 : 0);
  return Math.round(done / (fields.length + 2) * 100);
}

// ---------- Company profile ----------
router.get('/company/edit', H.requireLogin, (req, res) => {
  res.render('company-edit', { title: 'Company profile', c: req.company, industries: Object.keys(INDUSTRIES) });
});

router.post('/company/edit', H.requireLogin,
  H.uploadPublic.single('logo'), H.verifyCsrf, (req, res) => {
    const v = req.body; const c = req.company;
    const industries = [].concat(v.industries || []).join(', ');
    const isBuyer = v.is_buyer ? 1 : 0, isSupplier = v.is_supplier ? 1 : 0;
    if (!isBuyer && !isSupplier) { H.flash(req, 'error', 'Select at least one: Buyer or Supplier.'); return res.redirect('/company/edit'); }
    // Changing legal identity resets verification
    const identityChanged = (v.name !== c.name || (v.reg_number || '') !== (c.reg_number || '')) && c.verification_status === 'verified';
    run(`UPDATE companies SET name=?, business_type=?, is_buyer=?, is_supplier=?, country=?, city=?, address=?, website=?, phone=?, reg_number=?, tax_id=?,
         year_established=?, employees=?, description=?, industries=?, capabilities=?, production_capacity=?, certifications=?
         ${req.file ? ', logo=?' : ''} ${identityChanged ? ", verification_status='pending'" : ''} WHERE id=?`,
      ...[v.name, v.business_type || 'buyer', isBuyer, isSupplier, v.country, v.city, v.address, v.website, v.phone, v.reg_number, v.tax_id,
        v.year_established ? Number(v.year_established) : null, v.employees, v.description, industries, v.capabilities, v.production_capacity, v.certifications],
      ...(req.file ? [req.file.filename] : []), c.id);
    if (identityChanged) notifyAdmins(`${v.name} changed legal details — re-verification needed`, `/admin/companies/${c.id}`);
    H.flash(req, 'success', 'Company profile saved.');
    res.redirect('/company/edit');
  });

router.post('/company/verify', H.requireLogin, H.uploadPrivate.single('doc'), H.verifyCsrf, (req, res) => {
  const c = req.company;
  if (!c.reg_number && !req.file) { H.flash(req, 'error', 'Add your registration number or upload a registration certificate.'); return res.redirect('/company/edit'); }
  run("UPDATE companies SET verification_status='pending', verification_doc=COALESCE(?, verification_doc) WHERE id=?", req.file ? req.file.filename : null, c.id);
  notifyAdmins(`Verification requested: ${c.name}`, `/admin/companies/${c.id}`);
  H.flash(req, 'success', 'Verification request submitted. Our team will review your documents within 2 business days.');
  res.redirect('/company/edit');
});

// ---------- Notifications ----------
router.get('/notifications', H.requireLogin, (req, res) => {
  const rows = all('SELECT * FROM notifications WHERE user_id=? OR company_id=? ORDER BY created_at DESC LIMIT 100', req.user.id, req.user.company_id || -1);
  run('UPDATE notifications SET is_read=1 WHERE user_id=? OR company_id=?', req.user.id, req.user.company_id || -1);
  res.render('notifications', { title: 'Notifications', rows });
});

// ---------- Account / password ----------
router.get('/account', H.requireLogin, (req, res) => res.render('account', { title: 'My account', zones: require('../lib/tz').ZONES }));
router.post('/account', H.requireLogin, (req, res) => {
  const v = req.body;
  if (v.new_password) {
    if (!bcrypt.compareSync(v.current_password || '', req.user.password_hash)) { H.flash(req, 'error', 'Current password is incorrect.'); return res.redirect('/account'); }
    if (v.new_password.length < 8) { H.flash(req, 'error', 'New password must be at least 8 characters.'); return res.redirect('/account'); }
    run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(v.new_password, 11), req.user.id);
  }
  run('UPDATE users SET name=?, phone=?, designation=?, timezone=? WHERE id=?', v.name || req.user.name, v.phone || '', v.designation || '',
    require('../lib/tz').validTz(v.timezone || req.user.timezone), req.user.id);
  H.flash(req, 'success', 'Account updated.');
  res.redirect('/account');
});

// ---------- Protected file downloads ----------
function send(res, file) {
  const p = path.join(H.PRIVATE_UP, path.basename(file || ''));
  if (!file || !fs.existsSync(p)) return res.status(404).send('File not found');
  res.download(p);
}
const isAdmin = (req) => req.user.role === 'admin';

router.get('/files/requirement/:id', H.requireLogin, (req, res) => {
  const r = get('SELECT * FROM requirements WHERE id=?', req.params.id);
  if (!r) return res.sendStatus(404);
  const own = r.buyer_company_id === req.user.company_id;
  const inv = get('SELECT * FROM rfq_invites WHERE requirement_id=? AND supplier_company_id=?', r.id, req.user.company_id);
  const q = get('SELECT status FROM quotations WHERE requirement_id=? AND supplier_company_id=?', r.id, req.user.company_id);
  const released = inv && (!r.confidential || (q && ['shortlisted', 'awarded'].includes(q.status)));
  if (!own && !isAdmin(req) && !released) return H.deny(res, 'Drawings for confidential RFQs are released after the buyer shortlists your quotation.');
  send(res, r.attachment);
});
router.get('/files/quote/:id', H.requireLogin, (req, res) => {
  const q = get('SELECT q.*, r.buyer_company_id FROM quotations q JOIN requirements r ON r.id=q.requirement_id WHERE q.id=?', req.params.id);
  if (!q) return res.sendStatus(404);
  if (!isAdmin(req) && q.supplier_company_id !== req.user.company_id && q.buyer_company_id !== req.user.company_id) return H.deny(res, 'Not allowed.');
  send(res, q.attachment);
});
router.get('/files/verification/:id', H.requireLogin, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.params.id);
  if (!c || (!isAdmin(req) && c.id !== req.user.company_id)) return H.deny(res, 'Not allowed.');
  send(res, c.verification_doc);
});

module.exports = router;
