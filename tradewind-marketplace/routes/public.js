const router = require('express').Router();
const { all, get, run } = require('../lib/db');
const { INDUSTRIES } = require('../seed');

const categoriesByIndustry = () => {
  const rows = all('SELECT * FROM categories ORDER BY industry, name');
  const map = {}; for (const r of rows) (map[r.industry] ||= []).push(r);
  return map;
};

router.get('/', (req, res) => {
  const stats = {
    suppliers: get("SELECT COUNT(*) n FROM companies WHERE is_supplier=1 AND status='active'").n,
    products: get("SELECT COUNT(*) n FROM products WHERE status='active'").n,
    rfqs: get("SELECT COUNT(*) n FROM requirements WHERE status IN ('open','awarded','closed')").n,
    countries: get("SELECT COUNT(DISTINCT country) n FROM companies WHERE country != ''").n,
  };
  const featured = all(`SELECT p.*, c.name company_name, c.country, c.verification_status, cat.name category
      FROM products p JOIN companies c ON c.id=p.company_id LEFT JOIN categories cat ON cat.id=p.category_id
      WHERE p.status='active' AND c.status='active' ORDER BY p.featured DESC, c.featured DESC, p.created_at DESC LIMIT 8`);
  const latestRfqs = all(`SELECT r.*, cat.name category, c.country buyer_country FROM requirements r
      LEFT JOIN categories cat ON cat.id=r.category_id JOIN companies c ON c.id=r.buyer_company_id
      WHERE r.status='open' AND r.sourcing_type != 'confidential' ORDER BY r.created_at DESC LIMIT 6`);
  res.render('home', { title: 'Where Global Demand Meets Trusted Supply', stats, featured, latestRfqs, industries: Object.keys(INDUSTRIES) });
});

// Unified search: products or suppliers
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const type = req.query.type === 'suppliers' ? 'suppliers' : 'products';
  const { category, industry, country, availability, verified } = req.query;
  const like = `%${q}%`;
  let results = [];
  if (type === 'products') {
    const where = ["p.status='active'", "c.status='active'"]; const params = [];
    if (q) { where.push('(p.name LIKE ? OR p.material LIKE ? OR p.grade LIKE ? OR p.specifications LIKE ? OR c.name LIKE ? OR cat.name LIKE ?)'); params.push(like, like, like, like, like, like); }
    if (category) { where.push('p.category_id = ?'); params.push(Number(category)); }
    if (industry) { where.push('cat.industry = ?'); params.push(industry); }
    if (country) { where.push('c.country = ?'); params.push(country); }
    if (availability) { where.push('p.availability = ?'); params.push(availability); }
    if (verified) where.push("c.verification_status='verified'");
    results = all(`SELECT p.*, c.name company_name, c.country, c.verification_status, c.plan, cat.name category, cat.industry
      FROM products p JOIN companies c ON c.id=p.company_id LEFT JOIN categories cat ON cat.id=p.category_id
      WHERE ${where.join(' AND ')} ORDER BY p.featured DESC, (c.plan != 'free') DESC, (c.verification_status='verified') DESC, p.updated_at DESC LIMIT 100`, ...params);
  } else {
    const where = ["c.is_supplier=1", "c.status='active'"]; const params = [];
    if (q) { where.push('(c.name LIKE ? OR c.description LIKE ? OR c.capabilities LIKE ? OR c.industries LIKE ? OR c.certifications LIKE ? OR EXISTS (SELECT 1 FROM products px WHERE px.company_id=c.id AND px.name LIKE ?))'); params.push(like, like, like, like, like, like); }
    if (industry) { where.push('c.industries LIKE ?'); params.push(`%${industry}%`); }
    if (category) { where.push('EXISTS (SELECT 1 FROM products px WHERE px.company_id=c.id AND px.category_id=?)'); params.push(Number(category)); }
    if (country) { where.push('c.country = ?'); params.push(country); }
    if (availability === 'ready_stock') where.push("EXISTS (SELECT 1 FROM products px WHERE px.company_id=c.id AND px.availability='ready_stock' AND px.stock_qty>0)");
    if (verified) where.push("c.verification_status='verified'");
    results = all(`SELECT c.*, (SELECT COUNT(*) FROM products px WHERE px.company_id=c.id AND px.status='active') product_count
      FROM companies c WHERE ${where.join(' AND ')} ORDER BY c.featured DESC, (c.plan!='free') DESC, (c.verification_status='verified') DESC, c.name LIMIT 100`, ...params);
  }
  const countries = all("SELECT DISTINCT country FROM companies WHERE is_supplier=1 AND country != '' ORDER BY country").map(r => r.country);
  res.render('search', { title: 'Search', q, type, results, filters: req.query, cats: categoriesByIndustry(), countries });
});

router.get('/products/:id', (req, res) => {
  const p = get(`SELECT p.*, cat.name category, cat.industry FROM products p LEFT JOIN categories cat ON cat.id=p.category_id WHERE p.id=?`, req.params.id);
  if (!p || p.status !== 'active') return res.status(404).render('error', { title: 'Not found', message: 'This product is not available.' });
  const c = get('SELECT * FROM companies WHERE id=?', p.company_id);
  run('UPDATE products SET views = views + 1 WHERE id=?', p.id);
  const more = all("SELECT * FROM products WHERE company_id=? AND id!=? AND status='active' LIMIT 4", c.id, p.id);
  res.render('product', { title: p.name, p, c, more });
});

router.get('/companies/:id', (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.params.id);
  if (!c || c.status !== 'active' || (!c.is_supplier && !c.is_buyer)) return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
  const products = all(`SELECT p.*, cat.name category FROM products p LEFT JOIN categories cat ON cat.id=p.category_id WHERE p.company_id=? AND p.status='active' ORDER BY p.featured DESC, p.created_at DESC`, c.id);
  const saved = req.company ? !!get('SELECT 1 x FROM saved_suppliers WHERE buyer_company_id=? AND supplier_company_id=?', req.company.id, c.id) : false;
  const myOpenReqs = req.company && req.company.is_buyer ? all("SELECT id, ref, title FROM requirements WHERE buyer_company_id=? AND status='open'", req.company.id) : [];
  res.render('company', { title: c.name, c, products, saved, myOpenReqs });
});

// Public "buy leads" board — summary only; details/quoting require a supplier login
router.get('/requirements', (req, res) => {
  const { industry } = req.query;
  const params = []; let extra = '';
  if (industry) { extra = ' AND cat.industry = ?'; params.push(industry); }
  const rows = all(`SELECT r.*, cat.name category, cat.industry, c.country buyer_country,
      (SELECT COUNT(*) FROM quotations q WHERE q.requirement_id=r.id) quote_count
      FROM requirements r LEFT JOIN categories cat ON cat.id=r.category_id JOIN companies c ON c.id=r.buyer_company_id
      WHERE r.status='open' AND r.sourcing_type != 'confidential' ${extra} ORDER BY r.created_at DESC LIMIT 100`, ...params);
  res.render('requirements-board', { title: 'Live Buyer Requirements', rows, industry, industries: Object.keys(INDUSTRIES) });
});

router.get('/pricing', (req, res) => res.render('pricing', { title: 'Membership Plans' }));
router.get('/how-it-works', (req, res) => res.render('how', { title: 'How TradeWind Works' }));
router.get('/healthz', (req, res) => res.json({ ok: true }));

module.exports = router;
module.exports.categoriesByIndustry = categoriesByIndustry;
