// Database layer — uses Node's built-in SQLite (no native install needed).
// For production at scale, the same schema ports directly to PostgreSQL.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'tradewind.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'buyer',      -- buyer | manufacturer | trader | stockist | distributor
  is_buyer INTEGER NOT NULL DEFAULT 0,
  is_supplier INTEGER NOT NULL DEFAULT 0,
  country TEXT, city TEXT, address TEXT, website TEXT, phone TEXT,
  reg_number TEXT, tax_id TEXT, year_established INTEGER, employees TEXT,
  description TEXT,
  industries TEXT,              -- comma separated industry names
  capabilities TEXT,            -- e.g. CNC machining, sand casting, forging
  production_capacity TEXT,
  certifications TEXT,          -- e.g. ISO 9001, IATF 16949
  logo TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified', -- unverified | pending | verified | rejected
  verification_doc TEXT,
  verification_note TEXT,
  plan TEXT NOT NULL DEFAULT 'free',   -- free | premium | enterprise
  featured INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT, designation TEXT,
  role TEXT NOT NULL DEFAULT 'member',  -- member | admin
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  UNIQUE(name, industry)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  material TEXT, grade TEXT, specifications TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  stock_qty REAL NOT NULL DEFAULT 0,
  moq REAL NOT NULL DEFAULT 1,
  price REAL, currency TEXT NOT NULL DEFAULT 'USD',
  availability TEXT NOT NULL DEFAULT 'ready_stock', -- ready_stock | made_to_order
  lead_time_days INTEGER,
  incoterm TEXT,
  location TEXT,
  image TEXT, datasheet TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | hidden
  featured INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  buyer_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  material TEXT, grade TEXT, specifications TEXT,
  quantity REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs',
  target_price REAL, currency TEXT NOT NULL DEFAULT 'USD',
  incoterm TEXT,
  delivery_location TEXT, delivery_country TEXT,
  required_by TEXT, quote_deadline TEXT,
  confidential INTEGER NOT NULL DEFAULT 0,
  attachment TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | open | closed | awarded | rejected
  admin_note TEXT,
  awarded_quote_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rfq_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  match_score INTEGER NOT NULL DEFAULT 0,
  match_reasons TEXT,
  source TEXT NOT NULL DEFAULT 'auto',  -- auto | buyer | admin
  status TEXT NOT NULL DEFAULT 'sent',  -- sent | viewed | quoted | declined
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(requirement_id, supplier_company_id)
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  unit_price REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  quantity REAL, moq REAL, lead_time_days INTEGER,
  payment_terms TEXT, incoterm TEXT, validity_date TEXT,
  notes TEXT, attachment TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | submitted | shortlisted | awarded | rejected | withdrawn
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(requirement_id, supplier_company_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  company_a INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, -- initiator
  company_b INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,        -- notify everyone in a company
  user_id INTEGER,           -- or a single user (admins)
  text TEXT NOT NULL,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_suppliers (
  buyer_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (buyer_company_id, supplier_company_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS nda_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sent',   -- sent | supplier_signed | signed_both | declined
  supplier_signer_name TEXT, supplier_signer_title TEXT, supplier_signed_at TEXT, supplier_ip TEXT, supplier_signed_file TEXT,
  buyer_signer_name TEXT, buyer_signer_title TEXT, buyer_signed_at TEXT, buyer_ip TEXT,
  decline_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(requirement_id, supplier_company_id)
);

CREATE TABLE IF NOT EXISTS vault_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vault_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL, file_id INTEGER,
  company_id INTEGER, user_id INTEGER,
  action TEXT NOT NULL,   -- view | download | upload | delete | nda_view
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  requester_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requester_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  with_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, description TEXT,
  start_utc TEXT NOT NULL,        -- ISO UTC
  local_date TEXT, local_time TEXT, timezone TEXT NOT NULL DEFAULT 'UTC',
  duration_min INTEGER NOT NULL DEFAULT 60,
  alt_slot TEXT,
  mode TEXT NOT NULL DEFAULT 'online',      -- online | in_person
  platform TEXT NOT NULL DEFAULT 'zoom',    -- zoom | teams | meet | other
  location TEXT,
  link TEXT,
  status TEXT NOT NULL DEFAULT 'requested', -- requested | coordinated | confirmed | rescheduled | completed | cancelled
  last_action_company_id INTEGER,
  minutes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_req_buyer ON requirements(buyer_company_id);
CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_quotes_req ON quotations(requirement_id);
CREATE INDEX IF NOT EXISTS idx_msgs_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_notif ON notifications(company_id, user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_meet_a ON meetings(requester_company_id);
CREATE INDEX IF NOT EXISTS idx_meet_b ON meetings(with_company_id);
CREATE INDEX IF NOT EXISTS idx_vault_req ON vault_files(requirement_id);
`);

// ---- Safe migrations: add new columns to databases created by earlier versions ----
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// Confidential (NDA-gated) sourcing fields
addColumn('requirements', 'sourcing_type', "TEXT NOT NULL DEFAULT 'standard'"); // standard | confidential
addColumn('requirements', 'description', 'TEXT');
addColumn('requirements', 'industry', 'TEXT');
addColumn('requirements', 'annual_qty', 'REAL');
addColumn('requirements', 'batch_qty', 'REAL');
addColumn('requirements', 'weight_per_piece', 'REAL');
addColumn('requirements', 'process', 'TEXT');
addColumn('requirements', 'size_envelope', 'TEXT');
addColumn('requirements', 'certs_required', 'TEXT');
addColumn('requirements', 'preferred_countries', 'TEXT');
addColumn('requirements', 'share_target_price', 'INTEGER NOT NULL DEFAULT 1');
addColumn('requirements', 'nda_mode', "TEXT NOT NULL DEFAULT 'standard'");    // standard | own
addColumn('requirements', 'nda_file', 'TEXT');
addColumn('requirements', 'nda_file_name', 'TEXT');
addColumn('requirements', 'allow_download', 'INTEGER NOT NULL DEFAULT 0');
addColumn('rfq_invites', 'shortlisted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('rfq_invites', 'released', 'INTEGER NOT NULL DEFAULT 0');
addColumn('rfq_invites', 'released_at', 'TEXT');
addColumn('users', 'timezone', "TEXT NOT NULL DEFAULT 'UTC'");

// Small helpers so route code stays readable
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function setting(key, fallback) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

function notifyCompany(companyId, text, link) {
  if (!companyId) return;
  run('INSERT INTO notifications(company_id,text,link) VALUES(?,?,?)', companyId, text, link || null);
}
function notifyAdmins(text, link) {
  for (const a of all("SELECT id FROM users WHERE role='admin'")) {
    run('INSERT INTO notifications(user_id,text,link) VALUES(?,?,?)', a.id, text, link || null);
  }
}
function log(userId, action, detail) {
  run('INSERT INTO activity_log(user_id,action,detail) VALUES(?,?,?)', userId || null, action, detail || null);
}

module.exports = { db, all, get, run, setting, setSetting, notifyCompany, notifyAdmins, log, DATA_DIR };
