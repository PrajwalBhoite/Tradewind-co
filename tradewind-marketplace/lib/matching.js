// Buyer–Supplier matching engine.
// Scores every active supplier against a requirement using category, material,
// grade, stock vs quantity, MOQ, capabilities, location and verification.
// Weights are kept in one place so they can be tuned (and kept confidential).
const { all, get, run, notifyCompany } = require('./db');

const W = {
  category: 30,        // supplier lists a product in the same category
  industry: 12,        // supplier works in the category's industry
  keywords: 15,        // title/spec words found in product names / capabilities
  material: 12,
  grade: 8,
  stockCovers: 12,     // ready stock >= requested quantity
  stockPartial: 6,
  madeToOrder: 4,
  moqOk: 4,
  sameCountry: 3,
  verified: 8,
  premium: 2,
};
const MIN_SCORE = 30;
const MAX_AUTO_INVITES = 15;

const STOP = new Set('the and for with from of to in on a an per mm kg pcs nos ton tons qty quantity required supply supplier'.split(' '));
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t));
const has = (hay, needle) => needle && hay && String(hay).toLowerCase().includes(String(needle).toLowerCase().trim());

function scoreSupplier(req, company, products, category) {
  let score = 0;
  const reasons = [];
  const catProducts = products.filter(p => p.category_id && p.category_id === req.category_id);

  if (catProducts.length) { score += W.category; reasons.push('Lists products in this category'); }
  else if (category && has(company.industries, category.industry)) { score += W.industry; reasons.push(`Works in ${category.industry}`); }

  // keyword overlap between requirement and supplier's catalogue/capabilities
  const reqWords = new Set([...tokens(req.title), ...tokens(req.specifications)]);
  const supWords = new Set([...products.flatMap(p => tokens(p.name + ' ' + (p.specifications || ''))), ...tokens(company.capabilities)]);
  let hits = 0; for (const w of reqWords) if (supWords.has(w)) hits++;
  if (hits) { const k = Math.min(W.keywords, hits * 5); score += k; reasons.push(`${hits} keyword match${hits > 1 ? 'es' : ''}`); }

  const pool = catProducts.length ? catProducts : products;
  if (req.material && pool.some(p => has(p.material, req.material) || has(req.material, p.material))) { score += W.material; reasons.push(`Material: ${req.material}`); }
  if (req.grade && pool.some(p => has(p.grade, req.grade))) { score += W.grade; reasons.push(`Grade: ${req.grade}`); }

  const ready = pool.filter(p => p.availability === 'ready_stock' && p.stock_qty > 0);
  if (ready.some(p => p.stock_qty >= req.quantity)) { score += W.stockCovers; reasons.push('Ready stock covers quantity'); }
  else if (ready.length) { score += W.stockPartial; reasons.push('Partial ready stock'); }
  else if (pool.some(p => p.availability === 'made_to_order') || company.capabilities) { score += W.madeToOrder; reasons.push('Made to order'); }

  if (pool.length && pool.some(p => (p.moq || 0) <= req.quantity)) { score += W.moqOk; reasons.push('MOQ fits'); }
  if (req.delivery_country && company.country && company.country.toLowerCase() === req.delivery_country.toLowerCase()) { score += W.sameCountry; reasons.push('Same country'); }
  if (company.verification_status === 'verified') { score += W.verified; reasons.push('Verified supplier'); }
  if (company.plan !== 'free') score += W.premium;

  return { score: Math.min(100, score), reasons };
}

function findMatches(requirementId, limit = 50) {
  const req = get('SELECT * FROM requirements WHERE id = ?', requirementId);
  if (!req) return [];
  const category = req.category_id ? get('SELECT * FROM categories WHERE id = ?', req.category_id) : null;
  const suppliers = all("SELECT * FROM companies WHERE is_supplier = 1 AND status = 'active' AND id != ?", req.buyer_company_id);
  const results = [];
  for (const c of suppliers) {
    const products = all("SELECT * FROM products WHERE company_id = ? AND status = 'active'", c.id);
    const { score, reasons } = scoreSupplier(req, c, products, category);
    if (score >= MIN_SCORE) results.push({ company: c, score, reasons });
  }
  results.sort((a, b) => b.score - a.score || (b.company.verification_status === 'verified') - (a.company.verification_status === 'verified'));
  return results.slice(0, limit);
}

// Called when admin approves a requirement: send RFQ to the best-matched suppliers.
function distributeRFQ(requirementId) {
  const req = get('SELECT * FROM requirements WHERE id = ?', requirementId);
  const matches = findMatches(requirementId, MAX_AUTO_INVITES);
  let sent = 0;
  for (const m of matches) {
    const r = run(`INSERT OR IGNORE INTO rfq_invites(requirement_id, supplier_company_id, match_score, match_reasons, source)
                   VALUES(?,?,?,?, 'auto')`, requirementId, m.company.id, m.score, m.reasons.join(' · '));
    if (r.changes) {
      sent++;
      notifyCompany(m.company.id, `New matched RFQ ${req.ref}: ${req.title} (${m.score}% match)`, `/rfq/${requirementId}`);
    }
  }
  return sent;
}

module.exports = { findMatches, distributeRFQ, scoreSupplier, MIN_SCORE };
