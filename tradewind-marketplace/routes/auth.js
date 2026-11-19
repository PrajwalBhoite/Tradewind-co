const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { get, run, notifyAdmins, log } = require('../lib/db');
const { flash, COUNTRIES } = require('../lib/helpers');

// Simple in-memory brute-force protection for login
const attempts = new Map();
const tooMany = (key) => { const a = attempts.get(key); return a && a.count >= 8 && Date.now() - a.first < 15 * 60 * 1000; };
const fail = (key) => { const a = attempts.get(key); if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(key, { count: 1, first: Date.now() }); else a.count++; };

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('register', { title: 'Register', v: { as: req.query.as || 'buyer' }, errors: [], countries: COUNTRIES });
});

router.post('/register', (req, res) => {
  const v = req.body; const errors = [];
  const email = String(v.email || '').trim().toLowerCase();
  if (!v.name || v.name.trim().length < 2) errors.push('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Please enter a valid business email.');
  if (!v.password || v.password.length < 8 || !/\d/.test(v.password) || !/[A-Za-z]/.test(v.password)) errors.push('Password must be at least 8 characters with letters and numbers.');
  if (v.password !== v.password2) errors.push('Passwords do not match.');
  if (!v.company_name || v.company_name.trim().length < 2) errors.push('Company name is required.');
  if (!v.country) errors.push('Country is required.');
  if (!v.terms) errors.push('Please accept the terms of use.');
  if (get('SELECT id FROM users WHERE email=?', email)) errors.push('An account with this email already exists.');
  if (errors.length) return res.status(400).render('register', { title: 'Register', v, errors, countries: COUNTRIES });

  const as = v.as; // buyer | supplier | both
  const isBuyer = as === 'buyer' || as === 'both' ? 1 : 0;
  const isSupplier = as === 'supplier' || as === 'both' ? 1 : 0;
  const btype = isSupplier ? (v.business_type || 'manufacturer') : 'buyer';
  const c = run(`INSERT INTO companies(name,business_type,is_buyer,is_supplier,country,city,website,phone) VALUES(?,?,?,?,?,?,?,?)`,
    v.company_name.trim(), btype, isBuyer, isSupplier, v.country, v.city || '', v.website || '', v.phone || '');
  const u = run('INSERT INTO users(email,password_hash,name,phone,designation,company_id) VALUES(?,?,?,?,?,?)',
    email, bcrypt.hashSync(v.password, 11), v.name.trim(), v.phone || '', v.designation || '', c.lastInsertRowid);
  notifyAdmins(`New ${as} registration: ${v.company_name} (${v.country})`, `/admin/companies/${c.lastInsertRowid}`);
  log(u.lastInsertRowid, 'register', v.company_name);
  req.session.regenerate(() => {
    req.session.userId = u.lastInsertRowid;
    flash(req, 'success', 'Welcome to TradeWind Co.! Complete your company profile and submit it for verification to build trust.');
    res.redirect('/company/edit');
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Log in', email: '', error: null });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = req.ip + '|' + email;
  if (tooMany(key)) return res.status(429).render('login', { title: 'Log in', email, error: 'Too many attempts. Please wait 15 minutes.' });
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    fail(key);
    return res.status(401).render('login', { title: 'Log in', email, error: 'Incorrect email or password.' });
  }
  if (u.status !== 'active') return res.status(403).render('login', { title: 'Log in', email, error: 'This account is suspended. Contact support.' });
  attempts.delete(key);
  const back = req.session.returnTo;
  req.session.regenerate(() => {
    req.session.userId = u.id;
    run("UPDATE users SET last_login = datetime('now') WHERE id=?", u.id);
    res.redirect(back && back.startsWith('/') && !back.startsWith('//') ? back : (u.role === 'admin' ? '/admin' : '/dashboard'));
  });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

module.exports = router;
