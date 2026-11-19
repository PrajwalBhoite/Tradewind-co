// TradeWind Co. — Global B2B Buyer & Supplier Marketplace
// Entry point: node server.js   (then open http://localhost:3000)
const path = require('path');
const fs = require('fs');
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { get, all, setting } = require('./lib/db');
const SQLiteStore = require('./lib/session-store');
const H = require('./lib/helpers');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

// Auto-seed categories + admin on first run so the site is usable immediately
require('./seed').ensureBase();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers (lightweight, no extra dependency)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'self'",
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '7d' : 0 }));
app.use('/media', express.static(H.PUBLIC_UP, { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET || setting('session_secret') || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'tw.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD && process.env.INSECURE_COOKIE !== '1', maxAge: 7 * 24 * 3600 * 1000 },
}));

// Load current user + company and expose common values to every view
app.use((req, res, next) => {
  if (req.session.userId) {
    req.user = get('SELECT * FROM users WHERE id = ?', req.session.userId);
    if (req.user && req.user.company_id) req.company = get('SELECT * FROM companies WHERE id = ?', req.user.company_id);
  }
  const L = res.locals;
  L.user = req.user || null;
  L.company = req.company || null;
  L.csrf = H.csrfToken(req);
  L.flash = req.session.flash; delete req.session.flash;
  L.path = req.path;
  L.h = H;
  L.siteName = 'TradeWind Co.';
  L.unread = 0; L.unreadMsgs = 0;
  if (req.user) {
    L.unread = get(`SELECT COUNT(*) n FROM notifications WHERE is_read = 0 AND (user_id = ? OR company_id = ?)`, req.user.id, req.user.company_id || -1).n;
  }
  next();
});

// CSRF for normal forms (multipart forms verify after the upload middleware parses them)
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : H.verifyCsrf(req, res, next)));

app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/account'));
app.use('/supplier', require('./routes/supplier'));
app.use('/', require('./routes/buyer'));
app.use('/', require('./routes/messages'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 15 MB).' : (err.message === 'File type not allowed' ? 'That file type is not allowed.' : 'Something went wrong. Please try again.');
  res.status(err.status || 500).render('error', { title: 'Error', message: msg });
});

app.listen(PORT, () => {
  console.log(`\n  TradeWind Co. marketplace running →  http://localhost:${PORT}\n`);
  const admin = get("SELECT email FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (admin) console.log(`  Admin login: ${admin.email}  (password set in .env ADMIN_PASSWORD, default: Admin@12345)\n`);
});
