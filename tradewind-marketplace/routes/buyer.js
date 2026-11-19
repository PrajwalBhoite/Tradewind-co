// Requirements (buyer side), RFQ view & quoting (supplier side), quotation decisions, saved suppliers
const router = require('express').Router();
const { all, get, run, setting, notifyCompany, notifyAdmins, log } = require('../lib/db');
const H = require('../lib/helpers');
const { findMatches, distributeRFQ, addInvite } = require('../lib/matching');
const { categoriesByIndustry } = require('./public');

const L = [H.requireLogin, H.requireBuyer];
const S = [H.requireLogin, H.requireSupplier];

// ====================== BUYER: requirements ======================
router.get('/requirements/new', ...L, (req, res) => {
  res.render('buyer/requirement-form', { title: 'Post a requirement', r: { unit: 'pcs', currency: 'USD', incoterm: 'FOB', delivery_country: req.company.country }, cats: categoriesByIndustry() });
});

router.post('/requirements/new', ...L, H.uploadPrivate.single('attachment'), H.verifyCsrf, (req, res) => {
  const v = req.body;
  if (!v.title || !v.category_id || !(Number(v.quantity) > 0)) { H.flash(req, 'error', 'Title, category and a quantity greater than zero are required.'); return res.redirect('/requirements/new'); }
  const review = setting('requirement_review', '1') === '1';
  const id = run(`INSERT INTO requirements(buyer_company_id,user_id,title,category_id,material,grade,specifications,quantity,unit,target_price,currency,incoterm,
      delivery_location,delivery_country,required_by,quote_deadline,confidential,attachment,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.company.id, req.user.id, v.title.trim(), Number(v.category_id), v.material, v.grade, v.specifications, Number(v.quantity), v.unit,
    v.target_price === '' ? null : Number(v.target_price), v.currency, v.incoterm, v.delivery_location, v.delivery_country, v.required_by || null,
    v.quote_deadline || null, 0, req.file ? req.file.filename : null, review ? 'pending_review' : 'open').lastInsertRowid;
  const ref = 'RFQ-' + (1000 + Number(id));
  run('UPDATE requirements SET ref=? WHERE id=?', ref, id);
  log(req.user.id, 'requirement_posted', ref);
  if (review) {
    notifyAdmins(`New requirement to review: ${ref} ${v.title}`, `/admin/requirements`);
    H.flash(req, 'success', `${ref} submitted. Our team screens every requirement before it is sent to matched suppliers (usually within a few hours).`);
  } else {
    const n = distributeRFQ(id);
    H.flash(req, 'success', `${ref} is live and was sent to ${n} matched suppliers.`);
  }
  res.redirect('/my/requirements/' + id);
});

router.get('/my/requirements', ...L, (req, res) => {
  const rows = all(`SELECT r.*, cat.name category,
      (SELECT COUNT(*) FROM quotations q WHERE q.requirement_id=r.id AND q.status NOT IN ('pending_review','withdrawn')) quotes,
      (SELECT COUNT(*) FROM rfq_invites i WHERE i.requirement_id=r.id) invited
      FROM requirements r LEFT JOIN categories cat ON cat.id=r.category_id WHERE r.buyer_company_id=? ORDER BY r.created_at DESC`, req.company.id);
  res.render('buyer/requirements', { title: 'My requirements', rows });
});

function ownReq(req, res) {
  const r = get(`SELECT r.*, cat.name category, cat.industry FROM requirements r LEFT JOIN categories cat ON cat.id=r.category_id WHERE r.id=? AND r.buyer_company_id=?`, req.params.id, req.company.id);
  if (!r) { res.status(404).render('error', { title: 'Not found', message: 'Requirement not found.' }); return null; }
  return r;
}

router.get('/my/requirements/:id', ...L, (req, res) => {
  const r = ownReq(req, res); if (!r) return;
  const quotes = all(`SELECT q.*, s.name supplier, s.country, s.verification_status FROM quotations q JOIN companies s ON s.id=q.supplier_company_id
                      WHERE q.requirement_id=? AND q.status NOT IN ('pending_review','withdrawn') ORDER BY q.unit_price ASC`, r.id);
  const pendingQuotes = get("SELECT COUNT(*) n FROM quotations WHERE requirement_id=? AND status='pending_review'", r.id).n;
  const invites = all(`SELECT i.*, s.name supplier, s.country, s.verification_status FROM rfq_invites i JOIN companies s ON s.id=i.supplier_company_id
                       WHERE i.requirement_id=? ${r.sourcing_type === 'confidential' ? 'AND i.released=1' : ''} ORDER BY i.match_score DESC`, r.id);
  const invited = new Set(invites.map(i => i.supplier_company_id));
  const suggestions = r.sourcing_type !== 'confidential' && (r.status === 'open' || r.status === 'pending_review') ? findMatches(r.id, 12).filter(m => !invited.has(m.company.id)) : [];
  res.render('buyer/requirement', { title: r.ref, r, quotes, pendingQuotes, invites, suggestions });
});

router.get('/my/requirements/:id/compare', ...L, (req, res) => {
  const r = ownReq(req, res); if (!r) return;
  const quotes = all(`SELECT q.*, s.name supplier, s.country, s.verification_status, s.certifications, s.year_established, s.reg_number, s.tax_id, s.website, s.description, s.plan
                      FROM quotations q JOIN companies s ON s.id=q.supplier_company_id
                      WHERE q.requirement_id=? AND q.status NOT IN ('pending_review','withdrawn') ORDER BY q.unit_price`, r.id);
  for (const q of quotes) { q.total = q.unit_price * r.quantity; q.trust = H.trustScore(q); }
  const best = {
    price: Math.min(...quotes.map(q => q.unit_price)),
    lead: Math.min(...quotes.map(q => q.lead_time_days ?? Infinity)),
    trust: Math.max(...quotes.map(q => q.trust)),
  };
  const mixedCurrency = new Set(quotes.map(q => q.currency)).size > 1;
  res.render('buyer/compare', { title: 'Compare quotations', r, quotes, best, mixedCurrency });
});

router.post('/my/requirements/:id/invite', ...L, (req, res) => {
  const r = ownReq(req, res); if (!r) return;
  const sid = Number(req.body.supplier_company_id);
  const s = get("SELECT * FROM companies WHERE id=? AND is_supplier=1 AND status='active'", sid);
  if (s && s.id !== req.company.id) {
    addInvite(r.id, s.id, Number(req.body.score) || 0, 'buyer');
    H.flash(req, 'success', r.sourcing_type === 'confidential'
      ? `${s.name} added to your supplier profiles. Shortlist them and share your NDA from the confidential workspace.`
      : `${s.name} added to this RFQ${r.status !== 'open' ? ' (they will be notified once the RFQ is approved)' : ''}.`);
    if (r.sourcing_type === 'confidential' && req.body.back !== 'company') return res.redirect('/confidential/' + r.id);
  }
  res.redirect(req.body.back === 'company' ? `/companies/${sid}` : `/my/requirements/${r.id}`);
});

router.post('/my/requirements/:id/close', ...L, (req, res) => {
  const r = ownReq(req, res); if (!r) return;
  run("UPDATE requirements SET status='closed' WHERE id=?", r.id);
  for (const i of all('SELECT supplier_company_id FROM rfq_invites WHERE requirement_id=?', r.id)) notifyCompany(i.supplier_company_id, `${r.ref} was closed by the buyer.`, `/rfq/${r.id}`);
  H.flash(req, 'success', 'Requirement closed.');
  res.redirect('/my/requirements/' + r.id);
});

// Quote decisions by buyer
router.post('/quotes/:id/:action(shortlist|reject|award)', ...L, (req, res) => {
  const q = get('SELECT q.*, r.buyer_company_id, r.ref, r.id rid, r.title FROM quotations q JOIN requirements r ON r.id=q.requirement_id WHERE q.id=?', req.params.id);
  if (!q || q.buyer_company_id !== req.company.id || ['pending_review', 'withdrawn'].includes(q.status)) return res.redirect('/my/requirements');
  const a = req.params.action;
  if (a === 'shortlist') {
    run("UPDATE quotations SET status='shortlisted' WHERE id=?", q.id);
    notifyCompany(q.supplier_company_id, `Your quotation for ${q.ref} was shortlisted. Drawings/details are now released.`, `/rfq/${q.rid}`);
  } else if (a === 'reject') {
    run("UPDATE quotations SET status='rejected' WHERE id=?", q.id);
    notifyCompany(q.supplier_company_id, `Your quotation for ${q.ref} was not selected.`, `/rfq/${q.rid}`);
  } else if (a === 'award') {
    run("UPDATE quotations SET status='awarded' WHERE id=?", q.id);
    for (const o of all("SELECT id, supplier_company_id FROM quotations WHERE requirement_id=? AND id!=? AND status IN ('submitted','shortlisted')", q.rid, q.id)) {
      run("UPDATE quotations SET status='rejected' WHERE id=?", o.id);
      notifyCompany(o.supplier_company_id, `${q.ref} has been awarded to another supplier.`, `/rfq/${q.rid}`);
    }
    run("UPDATE requirements SET status='awarded', awarded_quote_id=? WHERE id=?", q.id, q.rid);
    notifyCompany(q.supplier_company_id, `Congratulations! You won ${q.ref}: ${q.title}. The buyer will contact you with the PO.`, `/rfq/${q.rid}`);
    notifyAdmins(`${q.ref} awarded`, `/admin/requirements`);
    log(req.user.id, 'award', q.ref);
  }
  H.flash(req, 'success', `Quotation ${a === 'award' ? 'awarded' : a + 'ed'}.`);
  res.redirect(req.get('referer') || `/my/requirements/${q.rid}`);
});

// Saved suppliers
router.post('/saved/:companyId', ...L, (req, res) => {
  const id = Number(req.params.companyId);
  const exists = get('SELECT 1 x FROM saved_suppliers WHERE buyer_company_id=? AND supplier_company_id=?', req.company.id, id);
  if (exists) run('DELETE FROM saved_suppliers WHERE buyer_company_id=? AND supplier_company_id=?', req.company.id, id);
  else run('INSERT OR IGNORE INTO saved_suppliers(buyer_company_id,supplier_company_id) VALUES(?,?)', req.company.id, id);
  res.redirect(req.get('referer') || '/my/saved');
});
router.get('/my/saved', ...L, (req, res) => {
  const rows = all(`SELECT c.* FROM saved_suppliers s JOIN companies c ON c.id=s.supplier_company_id WHERE s.buyer_company_id=? ORDER BY s.created_at DESC`, req.company.id);
  res.render('buyer/saved', { title: 'Saved suppliers', rows });
});

// ====================== SUPPLIER: view RFQ & quote ======================
function rfqAccess(req) {
  const r = get(`SELECT r.*, cat.name category, cat.industry, b.name buyer_name, b.country buyer_country, b.verification_status buyer_verified
                 FROM requirements r LEFT JOIN categories cat ON cat.id=r.category_id JOIN companies b ON b.id=r.buyer_company_id WHERE r.id=?`, req.params.id);
  if (!r || r.buyer_company_id === req.company.id) return { r };
  const invite = get('SELECT * FROM rfq_invites WHERE requirement_id=? AND supplier_company_id=?', r.id, req.company.id);
  // Confidential sourcing: the full RFQ is visible only after the NDA is signed by both parties and TradeWind releases it.
  if (r.sourcing_type === 'confidential') return { r, invite, can: !!(invite && invite.released) };
  // Open, non-confidential RFQs are visible on the public board; confidential ones only to invited suppliers.
  const can = !!(invite && invite.status !== 'proposed') || (r.status === 'open' && !r.confidential);
  return { r, invite, can };
}

router.get('/rfq/:id', ...S, (req, res) => {
  const { r, invite, can } = rfqAccess(req);
  if (r && r.buyer_company_id === req.company.id) return res.redirect('/my/requirements/' + r.id);
  if (r && r.sourcing_type === 'confidential' && !can && invite && get('SELECT 1 x FROM nda_agreements WHERE requirement_id=? AND supplier_company_id=?', r.id, req.company.id)) return res.redirect('/nda/' + r.id);
  if (!r || !can || r.status === 'pending_review' || r.status === 'rejected') return res.status(404).render('error', { title: 'Not available', message: 'This RFQ is not available to your company.' });
  if (invite && invite.status === 'sent') run("UPDATE rfq_invites SET status='viewed' WHERE id=?", invite.id);
  const quote = get('SELECT * FROM quotations WHERE requirement_id=? AND supplier_company_id=?', r.id, req.company.id);
  // Confidentiality masking: hide buyer identity & drawings until shortlisted/awarded
  const revealed = r.sourcing_type === 'confidential' || !r.confidential || (quote && ['shortlisted', 'awarded'].includes(quote.status));
  const vault = r.sourcing_type === 'confidential' ? all('SELECT * FROM vault_files WHERE requirement_id=? ORDER BY id', r.id) : [];
  const thread = get('SELECT id FROM threads WHERE requirement_id=? AND ((company_a=? AND company_b=?) OR (company_a=? AND company_b=?))', r.id, req.company.id, r.buyer_company_id, r.buyer_company_id, req.company.id);
  res.render('supplier/rfq', { title: r.ref, r, invite, quote, revealed, thread, vault, today: new Date().toISOString().slice(0, 10) });
});

router.post('/rfq/:id/quote', ...S, H.uploadPrivate.single('attachment'), H.verifyCsrf, (req, res) => {
  const { r, can } = rfqAccess(req);
  if (!r || !can || r.status !== 'open') { H.flash(req, 'error', 'This RFQ is no longer accepting quotations.'); return res.redirect('/supplier/rfqs'); }
  const v = req.body;
  if (!(Number(v.unit_price) > 0)) { H.flash(req, 'error', 'Please enter a valid unit price.'); return res.redirect('/rfq/' + r.id); }
  const existing = get('SELECT * FROM quotations WHERE requirement_id=? AND supplier_company_id=?', r.id, req.company.id);
  if (existing && ['awarded', 'rejected'].includes(existing.status)) return res.redirect('/rfq/' + r.id);
  const status = setting('quote_review', '1') === '1' ? 'pending_review' : 'submitted';
  const vals = [Number(v.unit_price), v.currency, Number(v.quantity) || r.quantity, Number(v.moq) || null, Number(v.lead_time_days) || null,
    v.payment_terms, v.incoterm, v.validity_date || null, v.notes];
  if (existing) {
    run(`UPDATE quotations SET unit_price=?, currency=?, quantity=?, moq=?, lead_time_days=?, payment_terms=?, incoterm=?, validity_date=?, notes=?,
         attachment=COALESCE(?, attachment), status=?, created_at=datetime('now') WHERE id=?`, ...vals, req.file ? req.file.filename : null,
      existing.status === 'shortlisted' ? 'shortlisted' : status, existing.id);
  } else {
    run(`INSERT INTO quotations(unit_price,currency,quantity,moq,lead_time_days,payment_terms,incoterm,validity_date,notes,attachment,status,requirement_id,supplier_company_id,user_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals, req.file ? req.file.filename : null, status, r.id, req.company.id, req.user.id);
    run("INSERT OR IGNORE INTO rfq_invites(requirement_id,supplier_company_id,source) VALUES(?,?,'self')", r.id, req.company.id);
  }
  run("UPDATE rfq_invites SET status='quoted' WHERE requirement_id=? AND supplier_company_id=?", r.id, req.company.id);
  if (status === 'pending_review') notifyAdmins(`Quotation to verify on ${r.ref} from ${req.company.name}`, '/admin/quotes');
  else notifyCompany(r.buyer_company_id, `New quotation on ${r.ref} from ${req.company.name}`, `/my/requirements/${r.id}`);
  H.flash(req, 'success', status === 'pending_review' ? 'Quotation submitted. It will be shared with the buyer after a quick compliance check.' : 'Quotation sent to the buyer.');
  res.redirect('/rfq/' + r.id);
});

router.post('/rfq/:id/decline', ...S, (req, res) => {
  run("UPDATE rfq_invites SET status='declined' WHERE requirement_id=? AND supplier_company_id=?", req.params.id, req.company.id);
  H.flash(req, 'success', 'RFQ declined.');
  res.redirect('/supplier/rfqs');
});

router.post('/quotes/:id/withdraw', ...S, (req, res) => {
  run("UPDATE quotations SET status='withdrawn' WHERE id=? AND supplier_company_id=? AND status IN ('pending_review','submitted','shortlisted')", req.params.id, req.company.id);
  H.flash(req, 'success', 'Quotation withdrawn.');
  res.redirect('/supplier/quotes');
});

module.exports = router;
