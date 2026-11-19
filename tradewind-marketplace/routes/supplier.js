// Supplier area: product & stock management, matched RFQ inbox, my quotations
const router = require('express').Router();
const { all, get, run } = require('../lib/db');
const H = require('../lib/helpers');
const { categoriesByIndustry } = require('./public');

router.use(H.requireLogin, H.requireSupplier);

router.get('/products', (req, res) => {
  const rows = all(`SELECT p.*, cat.name category FROM products p LEFT JOIN categories cat ON cat.id=p.category_id
                    WHERE p.company_id=? ORDER BY p.updated_at DESC`, req.company.id);
  res.render('supplier/products', { title: 'My products & stock', rows });
});

const blank = { unit: 'pcs', currency: 'USD', availability: 'ready_stock', moq: 1, stock_qty: 0, incoterm: 'FOB' };
router.get('/products/new', (req, res) => res.render('supplier/product-form', { title: 'Add product', p: blank, cats: categoriesByIndustry() }));

router.get('/products/:id/edit', (req, res) => {
  const p = get('SELECT * FROM products WHERE id=? AND company_id=?', req.params.id, req.company.id);
  if (!p) return res.redirect('/supplier/products');
  res.render('supplier/product-form', { title: 'Edit product', p, cats: categoriesByIndustry() });
});

const fields = H.uploadPublic.fields([{ name: 'image', maxCount: 1 }, { name: 'datasheet', maxCount: 1 }]);
router.post(['/products/new', '/products/:id/edit'], fields, H.verifyCsrf, (req, res) => {
  const v = req.body; const f = req.files || {};
  if (f.image && !H.IMAGE.test(f.image[0].originalname)) { H.flash(req, 'error', 'Product image must be JPG, PNG or WEBP.'); return res.redirect('back'); }
  if (!v.name || !v.category_id) { H.flash(req, 'error', 'Product name and category are required.'); return res.redirect('back'); }
  const vals = [v.name.trim(), Number(v.category_id), v.material, v.grade, v.specifications, v.unit, Number(v.stock_qty) || 0, Number(v.moq) || 1,
    v.price === '' ? null : Number(v.price), v.currency, v.availability, v.lead_time_days ? Number(v.lead_time_days) : null, v.incoterm, v.location,
    v.status === 'hidden' ? 'hidden' : 'active'];
  const img = f.image ? f.image[0].filename : null, ds = f.datasheet ? f.datasheet[0].filename : null;
  if (req.params.id) {
    const p = get('SELECT id FROM products WHERE id=? AND company_id=?', req.params.id, req.company.id);
    if (!p) return res.redirect('/supplier/products');
    run(`UPDATE products SET name=?, category_id=?, material=?, grade=?, specifications=?, unit=?, stock_qty=?, moq=?, price=?, currency=?, availability=?,
         lead_time_days=?, incoterm=?, location=?, status=?, image=COALESCE(?, image), datasheet=COALESCE(?, datasheet), updated_at=datetime('now') WHERE id=?`, ...vals, img, ds, p.id);
    H.flash(req, 'success', 'Product updated.');
  } else {
    run(`INSERT INTO products(name,category_id,material,grade,specifications,unit,stock_qty,moq,price,currency,availability,lead_time_days,incoterm,location,status,image,datasheet,company_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals, img, ds, req.company.id);
    H.flash(req, 'success', 'Product listed. It is now visible in search and used for RFQ matching.');
  }
  res.redirect('/supplier/products');
});

// Quick stock update from the list
router.post('/products/:id/stock', (req, res) => {
  run("UPDATE products SET stock_qty=?, updated_at=datetime('now') WHERE id=? AND company_id=?", Number(req.body.stock_qty) || 0, req.params.id, req.company.id);
  H.flash(req, 'success', 'Stock updated.');
  res.redirect('/supplier/products');
});
router.post('/products/:id/delete', (req, res) => {
  run('DELETE FROM products WHERE id=? AND company_id=?', req.params.id, req.company.id);
  H.flash(req, 'success', 'Product deleted.');
  res.redirect('/supplier/products');
});

// Matched / invited RFQs
router.get('/rfqs', (req, res) => {
  const rows = all(`SELECT i.*, r.ref, r.title, r.quantity, r.unit, r.quote_deadline, r.delivery_country, r.confidential, r.status req_status, r.incoterm,
                    cat.name category, q.status quote_status, q.id quote_id
                    FROM rfq_invites i JOIN requirements r ON r.id=i.requirement_id LEFT JOIN categories cat ON cat.id=r.category_id
                    LEFT JOIN quotations q ON q.requirement_id=r.id AND q.supplier_company_id=i.supplier_company_id
                    WHERE i.supplier_company_id=? AND i.status != 'proposed' AND (r.sourcing_type != 'confidential' OR i.released = 1)
                    ORDER BY (r.status='open') DESC, i.created_at DESC`, req.company.id);
  res.render('supplier/rfqs', { title: 'RFQ inbox', rows });
});

router.get('/quotes', (req, res) => {
  const rows = all(`SELECT q.*, r.ref, r.title, r.status req_status FROM quotations q JOIN requirements r ON r.id=q.requirement_id
                    WHERE q.supplier_company_id=? ORDER BY q.created_at DESC`, req.company.id);
  res.render('supplier/quotes', { title: 'My quotations', rows });
});

module.exports = router;
