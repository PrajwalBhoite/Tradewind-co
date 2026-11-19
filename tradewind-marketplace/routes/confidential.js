// CONFIDENTIAL SOURCING PORTAL (NDA-gated)
// Step 1  Buyer shares non-confidential basics only (no drawings)
// Step 2  TradeWind screens it and proposes verified supplier profiles (suppliers are not told anything)
// Step 3  Buyer shortlists suppliers
// Step 4  Buyer's NDA is shared with the shortlist; supplier e-signs, buyer countersigns -> "signed by both"
// Step 5  Full RFQ + drawings (secure vault) released only to NDA-signed suppliers, who then quote normally
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { all, get, run, setting, notifyCompany, notifyAdmins, log } = require('../lib/db');
const H = require('../lib/helpers');
const { distributeRFQ } = require('../lib/matching');
const { INDUSTRIES } = require('../seed');

const PROCESSES = ['Casting', 'Machining', 'Forging', 'Fabrication', 'Moulding', 'Assembly', 'Sheet metal', 'Other'];
const ip = (req) => (req.ip || '').replace('::ffff:', '');
const vlog = (req, rid, fileId, action) => run('INSERT INTO vault_access_log(requirement_id,file_id,company_id,user_id,action,ip) VALUES(?,?,?,?,?,?)',
  rid, fileId || null, req.user.company_id, req.user.id, action, ip(req));

// Where is this confidential RFQ in the 5-step flow?
function stageOf(r, invites, ndas) {
  if (r.status === 'pending_review' || r.status === 'rejected') return 1;
  if (invites.some(i => i.released)) return 5;
  if (ndas.some(n => n.status === 'signed_both')) return 4;
  if (invites.some(i => i.shortlisted)) return 3;
  return 2;
}

// =============================== BUYER SIDE ===============================
const B = [H.requireLogin, H.requireBuyer];

router.get('/confidential', ...B, (req, res) => {
  const rows = all(`SELECT r.*,
      (SELECT COUNT(*) FROM rfq_invites i WHERE i.requirement_id=r.id) profiles,
      (SELECT COUNT(*) FROM rfq_invites i WHERE i.requirement_id=r.id AND i.shortlisted=1) shortlisted,
      (SELECT COUNT(*) FROM nda_agreements n WHERE n.requirement_id=r.id AND n.status='signed_both') signed,
      (SELECT COUNT(*) FROM rfq_invites i WHERE i.requirement_id=r.id AND i.released=1) released,
      (SELECT COUNT(*) FROM quotations q WHERE q.requirement_id=r.id AND q.status NOT IN ('pending_review','withdrawn')) quotes
      FROM requirements r WHERE r.buyer_company_id=? AND r.sourcing_type='confidential' ORDER BY r.created_at DESC`, req.company.id);
  res.render('confidential/list', { title: 'Confidential sourcing', rows });
});

router.get('/confidential/new', ...B, (req, res) => {
  res.render('confidential/new', { title: 'Confidential sourcing — basic requirement', industries: Object.keys(INDUSTRIES), processes: PROCESSES,
    cats: require('./public').categoriesByIndustry(), v: { incoterm: 'CIF', currency: 'USD', unit: 'pcs', share_target_price: '1' } });
});

router.post('/confidential/new', ...B, H.uploadPrivate.single('nda_file'), H.verifyCsrf, (req, res) => {
  const v = req.body;
  const err = (m) => { H.flash(req, 'error', m); return res.redirect('/confidential/new'); };
  if (!v.title || !v.category_id || !v.description || !v.material) return err('Product name, category, brief description and material/grade are required.');
  if (!(Number(v.annual_qty) > 0) || !(Number(v.batch_qty) > 0)) return err('Annual quantity and batch quantity are mandatory.');
  if (!v.delivery_location) return err('Named port / delivery location is required.');
  if (v.nda_mode === 'own' && !req.file) return err('Upload your company NDA (PDF/DOCX) or choose the TradeWind standard NDA.');
  const processes = [].concat(v.process || []).join(', ');
  const cat = get('SELECT * FROM categories WHERE id=?', Number(v.category_id));
  const review = setting('requirement_review', '1') === '1';
  const id = run(`INSERT INTO requirements(buyer_company_id,user_id,title,category_id,industry,description,material,grade,weight_per_piece,process,size_envelope,certs_required,
      annual_qty,batch_qty,quantity,unit,target_price,currency,share_target_price,incoterm,delivery_location,delivery_country,preferred_countries,required_by,quote_deadline,
      confidential,sourcing_type,nda_mode,nda_file,nda_file_name,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'confidential',?,?,?,?)`,
    req.company.id, req.user.id, v.title.trim(), Number(v.category_id), cat ? cat.industry : '', v.description, v.material, v.grade || '',
    v.weight_per_piece ? Number(v.weight_per_piece) : null, processes, v.size_envelope, v.certs_required,
    Number(v.annual_qty), Number(v.batch_qty), Number(v.annual_qty), v.unit || 'pcs',
    v.target_price === '' ? null : Number(v.target_price), v.currency, v.share_target_price ? 1 : 0, v.incoterm, v.delivery_location, v.delivery_country,
    [].concat(v.preferred_countries || []).join(', '), v.required_by || null, v.quote_deadline || null,
    v.nda_mode === 'own' ? 'own' : 'standard', req.file ? req.file.filename : null, req.file ? req.file.originalname : null,
    review ? 'pending_review' : 'open').lastInsertRowid;
  const ref = 'TW-CS-' + (1000 + Number(id));
  run('UPDATE requirements SET ref=? WHERE id=?', ref, id);
  log(req.user.id, 'confidential_posted', ref);
  if (review) notifyAdmins(`Confidential sourcing request to screen: ${ref} ${v.title}`, `/admin/requirements/${id}`);
  else distributeRFQ(id);
  H.flash(req, 'success', `${ref} submitted. TradeWind will screen it and propose verified supplier profiles. No supplier sees anything until you share your NDA.`);
  res.redirect('/confidential/' + id);
});

function ownCS(req, res) {
  const r = get(`SELECT r.*, cat.name category FROM requirements r LEFT JOIN categories cat ON cat.id=r.category_id
                 WHERE r.id=? AND r.buyer_company_id=? AND r.sourcing_type='confidential'`, req.params.id, req.company.id);
  if (!r) { res.status(404).render('error', { title: 'Not found', message: 'Confidential requirement not found.' }); return null; }
  return r;
}

router.get('/confidential/:id', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  const invites = all(`SELECT i.*, c.name, c.business_type, c.country, c.capabilities, c.certifications, c.verification_status, c.reg_number, c.tax_id, c.website,
        c.year_established, c.description, c.plan, n.status nda_status, n.id nda_id, n.supplier_signer_name, n.supplier_signer_title, n.supplier_signed_at,
        n.buyer_signed_at, n.supplier_signed_file, n.decline_reason
      FROM rfq_invites i JOIN companies c ON c.id=i.supplier_company_id
      LEFT JOIN nda_agreements n ON n.requirement_id=i.requirement_id AND n.supplier_company_id=i.supplier_company_id
      WHERE i.requirement_id=? ORDER BY i.shortlisted DESC, i.match_score DESC`, r.id);
  for (const i of invites) i.trust = H.trustScore(i);
  const ndas = invites.filter(i => i.nda_status).map(i => ({ status: i.nda_status }));
  const tracker = {
    shared: invites.filter(i => i.nda_status).length,
    signedBoth: invites.filter(i => i.nda_status === 'signed_both').length,
    pendingSupplier: invites.filter(i => i.nda_status === 'sent').length,
    pendingBuyer: invites.filter(i => i.nda_status === 'supplier_signed').length,
    toRelease: invites.filter(i => i.nda_status === 'signed_both' && !i.released).length,
    unsent: invites.filter(i => i.shortlisted && !i.nda_status).length,
  };
  const vault = all('SELECT * FROM vault_files WHERE requirement_id=? ORDER BY id', r.id);
  const accessLog = all(`SELECT l.*, c.name company, u.name user, f.original_name file FROM vault_access_log l LEFT JOIN companies c ON c.id=l.company_id
      LEFT JOIN users u ON u.id=l.user_id LEFT JOIN vault_files f ON f.id=l.file_id WHERE l.requirement_id=? ORDER BY l.id DESC LIMIT 30`, r.id);
  const quotes = get("SELECT COUNT(*) n FROM quotations WHERE requirement_id=? AND status NOT IN ('pending_review','withdrawn')", r.id).n;
  res.render('confidential/workspace', { title: r.ref, r, invites, tracker, vault, accessLog, quotes, stage: stageOf(r, invites, ndas) });
});

// Step 3 — shortlist / un-shortlist a proposed supplier
router.post('/confidential/:id/shortlist', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  const sid = Number(req.body.supplier_company_id);
  const nda = get('SELECT id FROM nda_agreements WHERE requirement_id=? AND supplier_company_id=?', r.id, sid);
  if (nda) { H.flash(req, 'error', 'The NDA has already been shared with this supplier.'); return res.redirect('/confidential/' + r.id); }
  run('UPDATE rfq_invites SET shortlisted=? WHERE requirement_id=? AND supplier_company_id=?', req.body.on === '1' ? 1 : 0, r.id, sid);
  res.redirect('/confidential/' + r.id + '#profiles');
});

// NDA document setup (own NDA upload or TradeWind standard)
router.post('/confidential/:id/nda-doc', ...B, H.uploadPrivate.single('nda_file'), H.verifyCsrf, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  if (get('SELECT 1 x FROM nda_agreements WHERE requirement_id=?', r.id)) { H.flash(req, 'error', 'The NDA cannot be changed after it has been shared.'); return res.redirect('/confidential/' + r.id); }
  if (req.body.nda_mode === 'own' && !req.file && !r.nda_file) { H.flash(req, 'error', 'Please upload your NDA file.'); return res.redirect('/confidential/' + r.id); }
  run('UPDATE requirements SET nda_mode=?, nda_file=COALESCE(?, nda_file), nda_file_name=COALESCE(?, nda_file_name) WHERE id=?',
    req.body.nda_mode === 'own' ? 'own' : 'standard', req.file ? req.file.filename : null, req.file ? req.file.originalname : null, r.id);
  H.flash(req, 'success', 'NDA document saved.');
  res.redirect('/confidential/' + r.id + '#nda');
});

// Step 4a — share the NDA with every shortlisted supplier that hasn't received it
router.post('/confidential/:id/share-nda', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  if (r.status !== 'open') { H.flash(req, 'error', 'The requirement must be approved by TradeWind first.'); return res.redirect('/confidential/' + r.id); }
  const list = all(`SELECT i.supplier_company_id FROM rfq_invites i WHERE i.requirement_id=? AND i.shortlisted=1
                    AND NOT EXISTS (SELECT 1 FROM nda_agreements n WHERE n.requirement_id=i.requirement_id AND n.supplier_company_id=i.supplier_company_id)`, r.id);
  for (const i of list) {
    run("INSERT INTO nda_agreements(requirement_id,supplier_company_id,status) VALUES(?,?,'sent')", r.id, i.supplier_company_id);
    run("UPDATE rfq_invites SET status='sent' WHERE requirement_id=? AND supplier_company_id=?", r.id, i.supplier_company_id);
    notifyCompany(i.supplier_company_id, `NDA request: confidential RFQ ${r.ref} (${r.category || r.title}). Review and sign to receive the full RFQ.`, `/nda/${r.id}`);
  }
  log(req.user.id, 'nda_shared', `${r.ref} → ${list.length}`);
  H.flash(req, 'success', list.length ? `NDA shared with ${list.length} shortlisted supplier${list.length > 1 ? 's' : ''}.` : 'No new shortlisted suppliers to send the NDA to.');
  res.redirect('/confidential/' + r.id + '#nda');
});

// Step 4b — buyer countersigns an NDA the supplier has signed
router.post('/confidential/:id/countersign', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  const n = get("SELECT * FROM nda_agreements WHERE id=? AND requirement_id=? AND status='supplier_signed'", Number(req.body.nda_id), r.id);
  if (!n || !req.body.agree || !String(req.body.signer_name || '').trim()) { H.flash(req, 'error', 'Type your full name and confirm to countersign.'); return res.redirect('/confidential/' + r.id + '#nda'); }
  run("UPDATE nda_agreements SET status='signed_both', buyer_signer_name=?, buyer_signer_title=?, buyer_signed_at=datetime('now'), buyer_ip=? WHERE id=?",
    req.body.signer_name.trim(), req.body.signer_title || req.user.designation || '', ip(req), n.id);
  notifyCompany(n.supplier_company_id, `NDA for ${r.ref} is now signed by both parties. The full RFQ will be released to you shortly.`, `/nda/${r.id}`);
  log(req.user.id, 'nda_countersigned', r.ref);
  H.flash(req, 'success', 'NDA countersigned — signed by both parties. You can now release the RFQ to this supplier.');
  res.redirect('/confidential/' + r.id + '#nda');
});

// Step 5 — release full RFQ + vault to all NDA-signed suppliers
router.post('/confidential/:id/release', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  const list = all(`SELECT i.supplier_company_id FROM rfq_invites i JOIN nda_agreements n ON n.requirement_id=i.requirement_id AND n.supplier_company_id=i.supplier_company_id
                    WHERE i.requirement_id=? AND n.status='signed_both' AND i.released=0`, r.id);
  for (const i of list) {
    run("UPDATE rfq_invites SET released=1, released_at=datetime('now') WHERE requirement_id=? AND supplier_company_id=?", r.id, i.supplier_company_id);
    notifyCompany(i.supplier_company_id, `Full RFQ ${r.ref} released to you with drawings in the secure vault. Please submit your quotation.`, `/rfq/${r.id}`);
  }
  log(req.user.id, 'rfq_released', `${r.ref} → ${list.length}`);
  H.flash(req, 'success', `Full RFQ and drawings released to ${list.length} NDA-signed supplier${list.length === 1 ? '' : 's'}.`);
  res.redirect('/confidential/' + r.id);
});

// Full specification (shared only after release) + vault upload
router.post('/confidential/:id/details', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  run('UPDATE requirements SET specifications=?, quote_deadline=?, required_by=?, allow_download=? WHERE id=?',
    req.body.specifications || '', req.body.quote_deadline || null, req.body.required_by || null, req.body.allow_download ? 1 : 0, r.id);
  H.flash(req, 'success', 'Full RFQ details saved. They are visible only to released (NDA-signed) suppliers.');
  res.redirect('/confidential/' + r.id + '#vault');
});

router.post('/confidential/:id/vault', ...B, H.uploadPrivate.array('files', 10), H.verifyCsrf, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  for (const f of req.files || []) {
    const fid = run('INSERT INTO vault_files(requirement_id,filename,original_name,size,uploaded_by) VALUES(?,?,?,?,?)', r.id, f.filename, f.originalname, f.size, req.user.id).lastInsertRowid;
    vlog(req, r.id, fid, 'upload');
  }
  H.flash(req, 'success', `${(req.files || []).length} file(s) added to the secure vault.`);
  res.redirect('/confidential/' + r.id + '#vault');
});

router.post('/confidential/:id/vault/:fid/delete', ...B, (req, res) => {
  const r = ownCS(req, res); if (!r) return;
  const f = get('SELECT * FROM vault_files WHERE id=? AND requirement_id=?', req.params.fid, r.id);
  if (f) { fs.rmSync(path.join(H.PRIVATE_UP, f.filename), { force: true }); run('DELETE FROM vault_files WHERE id=?', f.id); vlog(req, r.id, null, 'delete'); }
  res.redirect('/confidential/' + r.id + '#vault');
});

// =============================== SUPPLIER SIDE ===============================
const S = [H.requireLogin, H.requireSupplier];

router.get('/supplier/ndas', ...S, (req, res) => {
  const rows = all(`SELECT n.*, r.ref, r.title, r.category_id, r.annual_qty, r.unit, r.delivery_location, r.status req_status, b.name buyer, b.country buyer_country, i.released
      FROM nda_agreements n JOIN requirements r ON r.id=n.requirement_id JOIN companies b ON b.id=r.buyer_company_id
      JOIN rfq_invites i ON i.requirement_id=n.requirement_id AND i.supplier_company_id=n.supplier_company_id
      WHERE n.supplier_company_id=? ORDER BY n.created_at DESC`, req.company.id);
  res.render('confidential/supplier-ndas', { title: 'NDA requests', rows });
});

function supplierNda(req, res) {
  const r = get(`SELECT r.*, cat.name category, b.name buyer, b.country buyer_country, b.city buyer_city, b.address buyer_address, b.verification_status buyer_verified
                 FROM requirements r LEFT JOIN categories cat ON cat.id=r.category_id JOIN companies b ON b.id=r.buyer_company_id
                 WHERE r.id=? AND r.sourcing_type='confidential'`, req.params.id);
  const n = r && get('SELECT * FROM nda_agreements WHERE requirement_id=? AND supplier_company_id=?', r.id, req.company.id);
  if (!r || !n) { res.status(404).render('error', { title: 'Not available', message: 'No NDA request found for your company.' }); return {}; }
  return { r, n };
}

// Supplier sees non-confidential basics + buyer NDA, and signs it
router.get('/nda/:id', ...S, (req, res) => {
  const { r, n } = supplierNda(req, res); if (!r) return;
  const invite = get('SELECT * FROM rfq_invites WHERE requirement_id=? AND supplier_company_id=?', r.id, req.company.id);
  res.render('confidential/supplier-nda', { title: 'NDA · ' + r.ref, r, n, invite });
});

router.post('/nda/:id/sign', ...S, H.uploadPrivate.single('signed_file'), H.verifyCsrf, (req, res) => {
  const { r, n } = supplierNda(req, res); if (!r) return;
  if (n.status !== 'sent') return res.redirect('/nda/' + r.id);
  if (!req.body.agree || !String(req.body.signer_name || '').trim() || !String(req.body.signer_title || '').trim()) {
    H.flash(req, 'error', 'Enter your full name and designation and confirm you are authorised to sign.'); return res.redirect('/nda/' + r.id);
  }
  run("UPDATE nda_agreements SET status='supplier_signed', supplier_signer_name=?, supplier_signer_title=?, supplier_signed_at=datetime('now'), supplier_ip=?, supplier_signed_file=? WHERE id=?",
    req.body.signer_name.trim(), req.body.signer_title.trim(), ip(req), req.file ? req.file.filename : null, n.id);
  notifyCompany(r.buyer_company_id, `${req.company.name} signed the NDA for ${r.ref}. Countersign to complete it.`, `/confidential/${r.id}#nda`);
  notifyAdmins(`NDA signed by ${req.company.name} for ${r.ref}`, `/admin/requirements/${r.id}`);
  log(req.user.id, 'nda_signed', r.ref);
  H.flash(req, 'success', 'NDA signed. Once the buyer countersigns, the full RFQ and drawings will be released to you.');
  res.redirect('/nda/' + r.id);
});

router.post('/nda/:id/decline', ...S, (req, res) => {
  const { r, n } = supplierNda(req, res); if (!r) return;
  if (n.status === 'sent') {
    run("UPDATE nda_agreements SET status='declined', decline_reason=? WHERE id=?", req.body.reason || '', n.id);
    run("UPDATE rfq_invites SET status='declined' WHERE requirement_id=? AND supplier_company_id=?", r.id, req.company.id);
    notifyCompany(r.buyer_company_id, `${req.company.name} declined the NDA for ${r.ref}.`, `/confidential/${r.id}`);
  }
  res.redirect('/supplier/ndas');
});

// =============================== SHARED: NDA document & secure vault ===============================
function canSeeNda(req, r) {
  if (req.user.role === 'admin' || r.buyer_company_id === req.user.company_id) return true;
  return !!get('SELECT 1 x FROM nda_agreements WHERE requirement_id=? AND supplier_company_id=?', r.id, req.user.company_id);
}

// Blank standard NDA template (preview)
router.get('/nda-template', (req, res) => res.render('confidential/nda-document', { title: 'TradeWind standard mutual NDA', r: null, supplier: null, n: null }));

// TradeWind standard mutual NDA, filled in with both parties
router.get('/nda/:id/document', H.requireLogin, (req, res) => {
  const r = get('SELECT r.*, b.name buyer, b.country buyer_country, b.address buyer_address FROM requirements r JOIN companies b ON b.id=r.buyer_company_id WHERE r.id=?', req.params.id);
  if (!r || !canSeeNda(req, r)) return H.deny(res, 'Not allowed.');
  const supplierId = r.buyer_company_id === req.user.company_id || req.user.role === 'admin' ? Number(req.query.supplier) || null : req.user.company_id;
  const supplier = supplierId ? get('SELECT * FROM companies WHERE id=?', supplierId) : null;
  const n = supplier ? get('SELECT * FROM nda_agreements WHERE requirement_id=? AND supplier_company_id=?', r.id, supplier.id) : null;
  if (req.user.company_id !== r.buyer_company_id) vlog(req, r.id, null, 'nda_view');
  res.render('confidential/nda-document', { title: 'Mutual NDA · ' + r.ref, r, supplier, n, layout: false });
});

router.get('/nda/:id/file', H.requireLogin, (req, res) => {
  const r = get('SELECT * FROM requirements WHERE id=?', req.params.id);
  if (!r || !r.nda_file || !canSeeNda(req, r)) return H.deny(res, 'Not allowed.');
  res.download(path.join(H.PRIVATE_UP, path.basename(r.nda_file)), r.nda_file_name || 'NDA.pdf');
});

router.get('/nda/signed/:ndaId', H.requireLogin, (req, res) => {
  const n = get('SELECT n.*, r.buyer_company_id FROM nda_agreements n JOIN requirements r ON r.id=n.requirement_id WHERE n.id=?', req.params.ndaId);
  if (!n || !n.supplier_signed_file || (req.user.role !== 'admin' && ![n.buyer_company_id, n.supplier_company_id].includes(req.user.company_id))) return H.deny(res, 'Not allowed.');
  res.download(path.join(H.PRIVATE_UP, path.basename(n.supplier_signed_file)), 'Signed_NDA' + path.extname(n.supplier_signed_file));
});

// Vault access: buyer (owner), admin, or a supplier whose NDA is signed by both AND who has been released
function vaultAccess(req) {
  const f = get('SELECT f.*, r.buyer_company_id, r.allow_download, r.ref FROM vault_files f JOIN requirements r ON r.id=f.requirement_id WHERE f.id=?', req.params.fid);
  if (!f) return {};
  const owner = f.buyer_company_id === req.user.company_id || req.user.role === 'admin';
  if (owner) return { f, owner: true };
  const ok = get(`SELECT 1 x FROM rfq_invites i JOIN nda_agreements n ON n.requirement_id=i.requirement_id AND n.supplier_company_id=i.supplier_company_id
                  WHERE i.requirement_id=? AND i.supplier_company_id=? AND i.released=1 AND n.status='signed_both'`, f.requirement_id, req.user.company_id);
  return ok ? { f, owner: false } : {};
}
const IMG = /\.(png|jpe?g|webp|gif)$/i, PDF = /\.pdf$/i;

router.get('/vault/:fid', H.requireLogin, (req, res) => {
  const { f, owner } = vaultAccess(req);
  if (!f) return H.deny(res, 'Drawings are released only to suppliers whose NDA is signed by both parties.');
  if (!owner) vlog(req, f.requirement_id, f.id, 'view');
  const mark = `CONFIDENTIAL · ${req.company ? req.company.name : 'TradeWind'} · ${req.user.email} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  res.set('Cache-Control', 'no-store');
  res.render('confidential/vault-view', { title: f.original_name, f, owner, mark, kind: IMG.test(f.original_name) ? 'img' : PDF.test(f.original_name) ? 'pdf' : 'other' });
});

router.get('/vault/:fid/raw', H.requireLogin, (req, res) => {
  const { f, owner } = vaultAccess(req);
  if (!f) return res.sendStatus(403);
  const download = req.query.download === '1';
  if (download && !owner && !f.allow_download) return res.sendStatus(403);
  if (!owner && download) vlog(req, f.requirement_id, f.id, 'download');
  res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
  const p = path.join(H.PRIVATE_UP, path.basename(f.filename));
  if (download) return res.download(p, f.original_name);
  res.set('Content-Disposition', 'inline');
  res.sendFile(p);
});

module.exports = router;
module.exports.PROCESSES = PROCESSES;
