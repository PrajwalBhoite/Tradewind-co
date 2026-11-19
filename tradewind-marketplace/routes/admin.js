// Admin control panel (Crescendo Worldwide backend operations)
const router = require('express').Router();
const { all, get, run, setting, setSetting, notifyCompany, log } = require('../lib/db');
const H = require('../lib/helpers');
const { distributeRFQ, findMatches } = require('../lib/matching');

router.use(H.requireLogin, H.requireAdmin);

router.get('/', (req, res) => {
  const n = (sql) => get(sql).n;
  const s = {
    companies: n("SELECT COUNT(*) n FROM companies WHERE is_buyer=1 OR is_supplier=1"),
    buyers: n('SELECT COUNT(*) n FROM companies WHERE is_buyer=1'),
    suppliers: n('SELECT COUNT(*) n FROM companies WHERE is_supplier=1'),
    verified: n("SELECT COUNT(*) n FROM companies WHERE verification_status='verified' AND (is_buyer=1 OR is_supplier=1)"),
    products: n('SELECT COUNT(*) n FROM products'),
    openRfqs: n("SELECT COUNT(*) n FROM requirements WHERE status='open'"),
    quotes: n('SELECT COUNT(*) n FROM quotations'),
    awarded: n("SELECT COUNT(*) n FROM requirements WHERE status='awarded'"),
    pendingVerify: n("SELECT COUNT(*) n FROM companies WHERE verification_status='pending'"),
    pendingReqs: n("SELECT COUNT(*) n FROM requirements WHERE status='pending_review'"),
    pendingQuotes: n("SELECT COUNT(*) n FROM quotations WHERE status='pending_review'"),
    premium: n("SELECT COUNT(*) n FROM companies WHERE plan!='free'"),
  };
  const recent = all(`SELECT a.*, u.name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 12`);
  const newCos = all("SELECT * FROM companies WHERE is_buyer=1 OR is_supplier=1 ORDER BY created_at DESC LIMIT 6");
  res.render('admin/index', { title: 'Admin', s, recent, newCos });
});

// ---------- Companies & verification ----------
router.get('/companies', (req, res) => {
  const { q = '', status = '' } = req.query; const p = []; let w = '(is_buyer=1 OR is_supplier=1)';
  if (q) { w += ' AND (name LIKE ? OR country LIKE ?)'; p.push(`%${q}%`, `%${q}%`); }
  if (status) { w += ' AND verification_status=?'; p.push(status); }
  const rows = all(`SELECT c.*, (SELECT email FROM users u WHERE u.company_id=c.id ORDER BY id LIMIT 1) email FROM companies c WHERE ${w}
                    ORDER BY (verification_status='pending') DESC, created_at DESC`, ...p);
  res.render('admin/companies', { title: 'Companies', rows, q, status });
});

router.get('/companies/:id', (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.params.id);
  if (!c) return res.redirect('/admin/companies');
  const users = all('SELECT * FROM users WHERE company_id=?', c.id);
  const products = all('SELECT * FROM products WHERE company_id=? ORDER BY created_at DESC', c.id);
  res.render('admin/company', { title: c.name, c, users, products });
});

router.post('/companies/:id', (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.params.id);
  if (!c) return res.redirect('/admin/companies');
  const a = req.body.action;
  if (a === 'verify') { run("UPDATE companies SET verification_status='verified', verification_note=? WHERE id=?", req.body.note || '', c.id); notifyCompany(c.id, 'Your company is now Verified on TradeWind Co. ✔', '/company/edit'); }
  if (a === 'reject') { run("UPDATE companies SET verification_status='rejected', verification_note=? WHERE id=?", req.body.note || '', c.id); notifyCompany(c.id, 'Verification could not be completed: ' + (req.body.note || 'please update your documents'), '/company/edit'); }
  if (a === 'suspend') { run("UPDATE companies SET status='suspended' WHERE id=?", c.id); run("UPDATE users SET status='suspended' WHERE company_id=?", c.id); }
  if (a === 'activate') { run("UPDATE companies SET status='active' WHERE id=?", c.id); run("UPDATE users SET status='active' WHERE company_id=?", c.id); }
  if (a === 'plan') run('UPDATE companies SET plan=?, featured=? WHERE id=?', req.body.plan || 'free', req.body.featured ? 1 : 0, c.id);
  log(req.user.id, 'admin_company_' + a, c.name);
  H.flash(req, 'success', 'Company updated.');
  res.redirect('/admin/companies/' + c.id);
});

// ---------- Requirement screening & distribution ----------
router.get('/requirements', (req, res) => {
  const rows = all(`SELECT r.*, c.name buyer, cat.name category,
      (SELECT COUNT(*) FROM rfq_invites i WHERE i.requirement_id=r.id) invited,
      (SELECT COUNT(*) FROM quotations q WHERE q.requirement_id=r.id) quotes
      FROM requirements r JOIN companies c ON c.id=r.buyer_company_id LEFT JOIN categories cat ON cat.id=r.category_id
      ORDER BY (r.status='pending_review') DESC, r.created_at DESC LIMIT 200`);
  res.render('admin/requirements', { title: 'Requirements', rows });
});

router.get('/requirements/:id', (req, res) => {
  const r = get(`SELECT r.*, c.name buyer, cat.name category FROM requirements r JOIN companies c ON c.id=r.buyer_company_id LEFT JOIN categories cat ON cat.id=r.category_id WHERE r.id=?`, req.params.id);
  if (!r) return res.redirect('/admin/requirements');
  const matches = findMatches(r.id, 30);
  const invites = all('SELECT i.*, c.name FROM rfq_invites i JOIN companies c ON c.id=i.supplier_company_id WHERE requirement_id=? ORDER BY match_score DESC', r.id);
  res.render('admin/requirement', { title: r.ref, r, matches, invites });
});

router.post('/requirements/:id', (req, res) => {
  const r = get('SELECT * FROM requirements WHERE id=?', req.params.id);
  if (!r) return res.redirect('/admin/requirements');
  const a = req.body.action;
  if (a === 'approve') {
    run("UPDATE requirements SET status='open', admin_note=? WHERE id=?", req.body.note || '', r.id);
    // notify any suppliers the buyer invited manually before approval
    for (const i of all('SELECT supplier_company_id FROM rfq_invites WHERE requirement_id=?', r.id)) notifyCompany(i.supplier_company_id, `You were invited to quote on ${r.ref}: ${r.title}`, `/rfq/${r.id}`);
    const n = distributeRFQ(r.id);
    notifyCompany(r.buyer_company_id, `${r.ref} approved and sent to ${n} matched suppliers.`, `/my/requirements/${r.id}`);
    H.flash(req, 'success', `Approved. RFQ distributed to ${n} matched suppliers.`);
  } else if (a === 'reject') {
    run("UPDATE requirements SET status='rejected', admin_note=? WHERE id=?", req.body.note || '', r.id);
    notifyCompany(r.buyer_company_id, `${r.ref} needs changes: ${req.body.note || 'please contact support'}`, `/my/requirements/${r.id}`);
    H.flash(req, 'success', 'Requirement rejected.');
  } else if (a === 'invite') {
    const sid = Number(req.body.supplier_company_id);
    const ins = run("INSERT OR IGNORE INTO rfq_invites(requirement_id,supplier_company_id,match_score,source) VALUES(?,?,?,'admin')", r.id, sid, Number(req.body.score) || 0);
    if (ins.changes && r.status === 'open') notifyCompany(sid, `New RFQ for you: ${r.ref} ${r.title}`, `/rfq/${r.id}`);
    H.flash(req, 'success', 'Supplier invited.');
  } else if (a === 'close') {
    run("UPDATE requirements SET status='closed' WHERE id=?", r.id);
  }
  log(req.user.id, 'admin_requirement_' + a, r.ref);
  res.redirect('/admin/requirements/' + r.id);
});

// ---------- Quotation verification ----------
router.get('/quotes', (req, res) => {
  const rows = all(`SELECT q.*, r.ref, r.title, r.target_price, r.currency req_currency, r.quantity req_qty, s.name supplier, s.verification_status
      FROM quotations q JOIN requirements r ON r.id=q.requirement_id JOIN companies s ON s.id=q.supplier_company_id
      ORDER BY (q.status='pending_review') DESC, q.created_at DESC LIMIT 200`);
  res.render('admin/quotes', { title: 'Quotations', rows });
});
router.post('/quotes/:id', (req, res) => {
  const q = get('SELECT q.*, r.buyer_company_id, r.ref, r.id rid FROM quotations q JOIN requirements r ON r.id=q.requirement_id WHERE q.id=?', req.params.id);
  if (q && q.status === 'pending_review') {
    if (req.body.action === 'approve') {
      run("UPDATE quotations SET status='submitted' WHERE id=?", q.id);
      notifyCompany(q.buyer_company_id, `New verified quotation on ${q.ref}`, `/my/requirements/${q.rid}`);
    } else {
      run("UPDATE quotations SET status='rejected' WHERE id=?", q.id);
      notifyCompany(q.supplier_company_id, `Your quotation on ${q.ref} was returned: ${req.body.note || 'incomplete information'}`, `/rfq/${q.rid}`);
    }
    log(req.user.id, 'admin_quote_' + req.body.action, q.ref);
  }
  res.redirect('/admin/quotes');
});

// ---------- Products moderation ----------
router.get('/products', (req, res) => {
  const rows = all(`SELECT p.*, c.name company, cat.name category FROM products p JOIN companies c ON c.id=p.company_id LEFT JOIN categories cat ON cat.id=p.category_id ORDER BY p.created_at DESC LIMIT 300`);
  res.render('admin/products', { title: 'Products', rows });
});
router.post('/products/:id', (req, res) => {
  const a = req.body.action;
  if (a === 'hide') run("UPDATE products SET status='hidden' WHERE id=?", req.params.id);
  if (a === 'show') run("UPDATE products SET status='active' WHERE id=?", req.params.id);
  if (a === 'feature') run('UPDATE products SET featured = 1 - featured WHERE id=?', req.params.id);
  res.redirect('/admin/products');
});

// ---------- Users ----------
router.get('/users', (req, res) => {
  const rows = all('SELECT u.*, c.name company FROM users u LEFT JOIN companies c ON c.id=u.company_id ORDER BY u.created_at DESC LIMIT 300');
  res.render('admin/users', { title: 'Users', rows });
});
router.post('/users/:id', (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', req.params.id);
  if (u && u.id !== req.user.id) {
    if (req.body.action === 'toggle') run('UPDATE users SET status=? WHERE id=?', u.status === 'active' ? 'suspended' : 'active', u.id);
    if (req.body.action === 'admin') run('UPDATE users SET role=? WHERE id=?', u.role === 'admin' ? 'member' : 'admin', u.id);
  }
  res.redirect('/admin/users');
});

// ---------- Categories ----------
router.get('/categories', (req, res) => {
  const rows = all('SELECT cat.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=cat.id) products FROM categories cat ORDER BY industry, name');
  res.render('admin/categories', { title: 'Industries & categories', rows });
});
router.post('/categories', (req, res) => {
  if (req.body.action === 'delete') run('DELETE FROM categories WHERE id=?', req.body.id);
  else if (req.body.name && req.body.industry) run('INSERT OR IGNORE INTO categories(name,industry) VALUES(?,?)', req.body.name.trim(), req.body.industry.trim());
  res.redirect('/admin/categories');
});

// ---------- Settings ----------
router.get('/settings', (req, res) => res.render('admin/settings', {
  title: 'Platform settings',
  s: { requirement_review: setting('requirement_review', '1'), quote_review: setting('quote_review', '1'), mask_contacts: setting('mask_contacts', '1') },
}));
router.post('/settings', (req, res) => {
  for (const k of ['requirement_review', 'quote_review', 'mask_contacts']) setSetting(k, req.body[k] ? '1' : '0');
  H.flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
