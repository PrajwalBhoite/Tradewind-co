// Shared middleware: auth guards, CSRF, uploads, formatting helpers.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { get } = require('./db');

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const PUBLIC_UP = path.join(UPLOAD_ROOT, 'public');   // product images, logos
const PRIVATE_UP = path.join(UPLOAD_ROOT, 'private'); // drawings, quotes, verification docs
fs.mkdirSync(PUBLIC_UP, { recursive: true });
fs.mkdirSync(PRIVATE_UP, { recursive: true });

const ALLOWED = /\.(pdf|png|jpe?g|webp|gif|docx?|xlsx?|csv|dwg|dxf|step|stp|igs|iges|zip)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

function makeUpload(dir, imagesOnly) {
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = imagesOnly ? IMAGE.test(file.originalname) : ALLOWED.test(file.originalname);
      cb(ok ? null : new Error('File type not allowed'), ok);
    },
  });
}
const uploadPublic = makeUpload(PUBLIC_UP, false);
const uploadPrivate = makeUpload(PRIVATE_UP, false);

// --- Auth guards ---
function requireLogin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  if (req.user.status !== 'active') { req.session.destroy(() => {}); return res.status(403).send('Account suspended'); }
  next();
}
function requireBuyer(req, res, next) {
  if (!req.company || !req.company.is_buyer) return deny(res, 'This area is for buyer accounts. Enable "Buyer" in your company profile.');
  next();
}
function requireSupplier(req, res, next) {
  if (!req.company || !req.company.is_supplier) return deny(res, 'This area is for supplier accounts. Enable "Supplier" in your company profile.');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return deny(res, 'Administrators only.');
  next();
}
function deny(res, msg) { return res.status(403).render('error', { title: 'Access denied', message: msg }); }

// --- CSRF (synchronizer token) ---
function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function verifyCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const t = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!t || t !== req.session.csrf) return res.status(403).render('error', { title: 'Session expired', message: 'Please go back, refresh the page and try again.' });
  next();
}

function flash(req, type, msg) { req.session.flash = { type, msg }; }

// --- formatting ---
const money = (v, cur) => v == null || v === '' ? '—' : `${cur || 'USD'} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const num = (v) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const date = (d) => d ? new Date(d.replace(' ', 'T') + (d.length <= 10 ? '' : 'Z')).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const ago = (d) => {
  if (!d) return '';
  const s = (Date.now() - new Date(d.replace(' ', 'T') + 'Z').getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
};
const STATUS_LABEL = {
  pending_review: 'Under review', open: 'Open', closed: 'Closed', awarded: 'Awarded', rejected: 'Rejected',
  submitted: 'Submitted', shortlisted: 'Shortlisted', withdrawn: 'Withdrawn',
  sent: 'New', viewed: 'Viewed', quoted: 'Quoted', declined: 'Declined',
  unverified: 'Unverified', pending: 'Verification pending', verified: 'Verified',
  ready_stock: 'Ready stock', made_to_order: 'Made to order', active: 'Active', hidden: 'Hidden', suspended: 'Suspended',
};
const label = (s) => STATUS_LABEL[s] || s;

// Trust score shown on profiles (0–100), derived from verifiable facts.
function trustScore(c) {
  let s = 20;
  if (c.verification_status === 'verified') s += 35;
  if (c.reg_number) s += 8; if (c.tax_id) s += 7; if (c.website) s += 5;
  if (c.certifications) s += 10; if (c.year_established && c.year_established < new Date().getFullYear() - 5) s += 5;
  if (c.description && c.description.length > 80) s += 5; if (c.plan !== 'free') s += 5;
  return Math.min(100, s);
}

const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
const CURRENCIES = ['USD', 'EUR', 'INR', 'GBP', 'AED', 'CNY', 'JPY', 'SGD'];
const UNITS = ['pcs', 'kg', 'tons', 'metres', 'sets', 'litres', 'sq.m', 'boxes', 'rolls'];
const COUNTRIES = ['India', 'United Arab Emirates', 'United States', 'United Kingdom', 'Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Turkey', 'China', 'Japan', 'South Korea', 'Singapore', 'Malaysia', 'Thailand', 'Vietnam', 'Indonesia', 'Saudi Arabia', 'Qatar', 'Egypt', 'South Africa', 'Kenya', 'Nigeria', 'Brazil', 'Mexico', 'Canada', 'Australia', 'Poland', 'Czech Republic', 'Sweden', 'Bangladesh', 'Sri Lanka', 'Other'];

module.exports = {
  uploadPublic, uploadPrivate, PUBLIC_UP, PRIVATE_UP, IMAGE,
  requireLogin, requireBuyer, requireSupplier, requireAdmin, deny,
  csrfToken, verifyCsrf, flash,
  money, num, date, ago, label, trustScore, INCOTERMS, CURRENCIES, UNITS, COUNTRIES,
};
