// Seeding:
//   ensureBase()   -> runs automatically on start: categories, admin account, settings
//   node seed.js   -> adds demo buyers, suppliers, products, RFQs and quotes
//   node seed.js --reset -> wipes the database first
const path = require('path');
const fs = require('fs');
if (require.main === module && fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));

if (require.main === module && process.argv.includes('--reset')) {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  for (const f of ['tradewind.db', 'tradewind.db-wal', 'tradewind.db-shm']) fs.rmSync(path.join(dir, f), { force: true });
  console.log('Database wiped.');
}

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { get, run, all, setting, setSetting } = require('./lib/db');

const INDUSTRIES = {
  'Automotive & Auto Components': ['Engine Components', 'Brake Systems', 'Transmission Parts', 'Fasteners', 'Automotive Electricals'],
  'Railway & Transportation': ['Rolling Stock Components', 'Track Components', 'Railway Castings'],
  'Aerospace & Aviation': ['Precision Machined Parts', 'Aerospace Fasteners', 'Composite Components'],
  'Defence & Engineering': ['Defence Components', 'Engineering Assemblies'],
  'Industrial Machinery': ['Pumps', 'Gearboxes', 'Bearings', 'Hydraulics & Pneumatics', 'CNC Machined Parts'],
  'Metal Castings & Forgings': ['Iron Castings', 'Steel Castings', 'Aluminium Die Castings', 'Investment Castings', 'Closed Die Forgings'],
  'Electrical & Electronics': ['Cables & Wires', 'Transformers', 'Switchgear', 'PCB Assemblies', 'Motors'],
  'Rubber & Plastic Products': ['Rubber Moulded Parts', 'O-Rings & Seals', 'Plastic Injection Moulding'],
  'Valves & Industrial Equipment': ['Gate Valves', 'Ball Valves', 'Butterfly Valves', 'Pipe Fittings & Flanges'],
  'Renewable Energy & Solar': ['Solar Modules', 'Solar Mounting Structures', 'Inverters', 'Wind Turbine Components'],
  'Construction & Infrastructure': ['Structural Steel', 'TMT Bars', 'Construction Equipment Parts'],
  'Marine & Shipbuilding': ['Marine Castings', 'Marine Hardware', 'Propulsion Components'],
  'Raw Materials & Industrial Consumables': ['Steel Plates & Coils', 'Non-Ferrous Metals', 'Welding Consumables', 'Industrial Chemicals', 'Abrasives & Cutting Tools'],
};

function ensureBase() {
  if (!get('SELECT id FROM categories LIMIT 1')) {
    for (const [ind, cats] of Object.entries(INDUSTRIES)) for (const c of cats) run('INSERT OR IGNORE INTO categories(name,industry) VALUES(?,?)', c, ind);
  }
  if (!setting('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  if (!setting('quote_review')) setSetting('quote_review', '1');           // Crescendo reviews quotes before buyers see them
  if (!setting('requirement_review')) setSetting('requirement_review', '1'); // requirements screened before distribution
  if (!get("SELECT id FROM users WHERE role='admin'")) {
    const email = process.env.ADMIN_EMAIL || 'admin@tradewind.local';
    const pass = process.env.ADMIN_PASSWORD || 'Admin@12345';
    const c = run(`INSERT INTO companies(name,business_type,is_buyer,is_supplier,country,city,verification_status,description)
                   VALUES('Crescendo Worldwide (Platform Admin)','buyer',0,0,'India','Pune','verified','Platform operator')`);
    run("INSERT INTO users(email,password_hash,name,role,company_id) VALUES(?,?,?,'admin',?)", email, bcrypt.hashSync(pass, 10), 'Platform Admin', c.lastInsertRowid);
    console.log(`Created admin account: ${email}`);
  }
}

function demo() {
  ensureBase();
  if (get("SELECT id FROM users WHERE email='buyer@demo.com'")) { console.log('Demo data already present.'); return; }
  const pw = bcrypt.hashSync('Demo@1234', 10);
  const cat = (name) => get('SELECT id FROM categories WHERE name=?', name).id;

  const mk = (c, user) => {
    const r = run(`INSERT INTO companies(name,business_type,is_buyer,is_supplier,country,city,address,website,reg_number,tax_id,year_established,employees,
      description,industries,capabilities,production_capacity,certifications,verification_status,plan,featured)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.name, c.type, c.buyer ? 1 : 0, c.supplier ? 1 : 0, c.country, c.city, c.address || '', c.website || '', c.reg || '', c.tax || '',
      c.year || null, c.emp || '', c.desc, c.ind || '', c.cap || '', c.capacity || '', c.cert || '', c.ver || 'unverified', c.plan || 'free', c.featured ? 1 : 0);
    const id = r.lastInsertRowid;
    run('INSERT INTO users(email,password_hash,name,designation,company_id) VALUES(?,?,?,?,?)', user.email, pw, user.name, user.title || '', id);
    return id;
  };

  const buyer = mk({ name: 'Apex Rail Systems Ltd', type: 'buyer', buyer: 1, country: 'United Arab Emirates', city: 'Dubai', website: 'https://example.com', reg: 'DXB-883421', year: 2009, emp: '200-500',
    desc: 'Rolling stock maintenance and EPC contractor for metro and freight rail projects across the GCC.', ind: 'Railway & Transportation', ver: 'verified' },
    { email: 'buyer@demo.com', name: 'Omar Haddad', title: 'Procurement Manager' });
  const buyer2 = mk({ name: 'NordWind Energy GmbH', type: 'buyer', buyer: 1, country: 'Germany', city: 'Hamburg', desc: 'Developer of utility-scale wind and solar parks in Northern Europe.', ind: 'Renewable Energy & Solar', ver: 'verified' },
    { email: 'buyer2@demo.com', name: 'Lena Fischer', title: 'Strategic Sourcing' });

  const s1 = mk({ name: 'Kale Precision Castings Pvt Ltd', type: 'manufacturer', supplier: 1, country: 'India', city: 'Kolhapur', reg: 'U27100MH2004PTC148812', tax: '27AABCK1234F1Z5', year: 2004, emp: '200-500',
    website: 'https://example.com', desc: 'Grey and SG iron castings from 5 kg to 2,000 kg for railway, pumps, valves and automotive OEMs. In-house pattern shop, machining and NABL lab.',
    ind: 'Metal Castings & Forgings, Railway & Transportation, Valves & Industrial Equipment', cap: 'Sand casting, shell moulding, SG iron, grey iron, CNC machining, painting, pattern making',
    capacity: '1,200 MT / month', cert: 'ISO 9001:2015, IATF 16949, EN 15085', ver: 'verified', plan: 'premium', featured: 1 },
    { email: 'supplier@demo.com', name: 'Rahul Patil', title: 'Export Manager' });
  const s2 = mk({ name: 'Sunrise Forge & Valves', type: 'manufacturer', supplier: 1, buyer: 1, country: 'India', city: 'Rajkot', year: 2011, emp: '50-200',
    desc: 'Closed die forgings and forged steel valves to API 6D / API 602.', ind: 'Valves & Industrial Equipment, Metal Castings & Forgings',
    cap: 'Closed die forging, heat treatment, CNC machining, hydro testing', capacity: '400 MT / month', cert: 'ISO 9001:2015, API 6D', ver: 'verified' },
    { email: 'supplier2@demo.com', name: 'Mehul Shah', title: 'Director' });
  const s3 = mk({ name: 'Gulf Steel Traders FZE', type: 'stockist', supplier: 1, country: 'United Arab Emirates', city: 'Sharjah', year: 2015, emp: '10-50',
    desc: 'Stockist of steel plates, coils, pipes and flanges with ready stock in Sharjah and Jebel Ali.', ind: 'Raw Materials & Industrial Consumables, Construction & Infrastructure',
    cap: 'Plate cutting, ready stock, mill test certificates', cert: 'ISO 9001:2015', ver: 'pending' },
    { email: 'supplier3@demo.com', name: 'Ahmed Rafiq', title: 'Sales Head' });
  const s4 = mk({ name: 'Helios Solar Components Co.', type: 'manufacturer', supplier: 1, country: 'Vietnam', city: 'Hai Phong', year: 2017, emp: '500+',
    desc: 'Hot-dip galvanised solar mounting structures and module frames.', ind: 'Renewable Energy & Solar, Construction & Infrastructure',
    cap: 'Roll forming, hot-dip galvanising, laser cutting', capacity: '3 GW / year', cert: 'ISO 9001, ISO 14001', ver: 'verified', plan: 'premium' },
    { email: 'supplier4@demo.com', name: 'Tran Minh', title: 'Key Accounts' });

  const P = (co, p) => run(`INSERT INTO products(company_id,name,category_id,material,grade,specifications,unit,stock_qty,moq,price,currency,availability,lead_time_days,incoterm,location,featured)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, co, p.name, cat(p.cat), p.mat || '', p.grade || '', p.spec || '', p.unit || 'pcs', p.stock || 0, p.moq || 1,
     p.price ?? null, p.cur || 'USD', p.avail || 'ready_stock', p.lead || null, p.inc || 'FOB', p.loc || '', p.featured ? 1 : 0);

  P(s1, { name: 'SG Iron Brake Disc Casting', cat: 'Railway Castings', mat: 'SG Iron', grade: 'EN-GJS-500-7', spec: 'Rough cast or machined, 18–45 kg, as per drawing', stock: 0, moq: 200, price: 3.1, unit: 'kg', avail: 'made_to_order', lead: 45, loc: 'Kolhapur, India', featured: 1 });
  P(s1, { name: 'Grey Iron Pump Casing', cat: 'Iron Castings', mat: 'Grey Iron', grade: 'FG 260', spec: 'Pump casings and impeller housings up to 800 kg', moq: 50, price: 2.4, unit: 'kg', avail: 'made_to_order', lead: 40, loc: 'Kolhapur, India' });
  P(s1, { name: 'Railway Axle Box Housing', cat: 'Rolling Stock Components', mat: 'SG Iron', grade: 'EN-GJS-400-18', spec: 'Machined axle box housing, EN 15085 welding where applicable', stock: 320, moq: 50, price: 145, loc: 'Kolhapur, India' });
  P(s2, { name: 'Forged Steel Gate Valve 2"', cat: 'Gate Valves', mat: 'Carbon Steel', grade: 'ASTM A105', spec: 'Class 800, API 602, socket weld ends', stock: 1500, moq: 100, price: 38, loc: 'Rajkot, India', featured: 1 });
  P(s2, { name: 'Closed Die Forged Flange', cat: 'Pipe Fittings & Flanges', mat: 'Carbon Steel', grade: 'ASTM A105', spec: 'Weld neck flanges ½"–24", ASME B16.5', stock: 4000, moq: 200, price: 11, loc: 'Rajkot, India' });
  P(s3, { name: 'Hot Rolled Steel Plate', cat: 'Steel Plates & Coils', mat: 'Carbon Steel', grade: 'S355JR', spec: '6–50 mm thick, 2000 x 6000 mm, with MTC 3.1', unit: 'tons', stock: 850, moq: 5, price: 690, inc: 'EXW', loc: 'Sharjah, UAE' });
  P(s3, { name: 'Seamless Carbon Steel Pipe', cat: 'Steel Plates & Coils', mat: 'Carbon Steel', grade: 'ASTM A106 Gr.B', spec: '½"–24", SCH 40/80', unit: 'tons', stock: 300, moq: 2, price: 980, inc: 'EXW', loc: 'Jebel Ali, UAE' });
  P(s4, { name: 'HDG Solar Mounting Structure', cat: 'Solar Mounting Structures', mat: 'Galvanised Steel', grade: 'S350GD + Z275', spec: 'Fixed-tilt ground mount, 2P portrait, wind load 45 m/s', unit: 'sets', stock: 2000, moq: 100, price: 52, cur: 'USD', loc: 'Hai Phong, Vietnam', featured: 1 });
  P(s4, { name: 'Aluminium Module Frame Profile', cat: 'Solar Modules', mat: 'Aluminium', grade: '6063-T5', spec: 'Anodised 15 µm, custom lengths', unit: 'kg', stock: 25000, moq: 1000, price: 4.2, loc: 'Hai Phong, Vietnam' });

  const { distributeRFQ } = require('./lib/matching');
  const R = (b, u, r) => {
    const id = run(`INSERT INTO requirements(buyer_company_id,user_id,title,category_id,material,grade,specifications,quantity,unit,target_price,currency,incoterm,delivery_location,delivery_country,required_by,quote_deadline,confidential,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now',?),date('now',?),?,?)`, b, u, r.title, cat(r.cat), r.mat, r.grade, r.spec, r.qty, r.unit, r.target, r.cur || 'USD', r.inc, r.loc, r.country, r.by, r.dl, r.conf ? 1 : 0, r.status).lastInsertRowid;
    run('UPDATE requirements SET ref=? WHERE id=?', 'RFQ-' + String(1000 + Number(id)), id);
    if (r.status === 'open') distributeRFQ(id);
    return id;
  };
  const u1 = get("SELECT id FROM users WHERE email='buyer@demo.com'").id;
  const u2 = get("SELECT id FROM users WHERE email='buyer2@demo.com'").id;
  const r1 = R(buyer, u1, { title: 'SG Iron brake disc castings for metro bogies', cat: 'Railway Castings', mat: 'SG Iron', grade: 'EN-GJS-500-7', spec: 'Machined brake discs as per drawing, 32 kg each, 3.1 material certificates, UT tested.', qty: 2400, unit: 'pcs', target: 118, inc: 'CIF', loc: 'Jebel Ali Port', country: 'United Arab Emirates', by: '+75 days', dl: '+14 days', status: 'open' });
  R(buyer, u1, { title: 'Forged gate valves 2" Class 800', cat: 'Gate Valves', mat: 'Carbon Steel', grade: 'ASTM A105', spec: 'API 602, SW ends, with test certificates', qty: 600, unit: 'pcs', target: 35, inc: 'FOB', loc: 'Dubai', country: 'United Arab Emirates', by: '+45 days', dl: '+10 days', status: 'open', conf: 1 });
  R(buyer2, u2, { title: 'Ground-mount solar structures for 40 MW park', cat: 'Solar Mounting Structures', mat: 'Galvanised Steel', grade: 'S350GD', spec: 'Fixed tilt 25°, 2P portrait, Eurocode wind/snow loads, design support required', qty: 1600, unit: 'sets', target: 50, cur: 'EUR', inc: 'DAP', loc: 'Hamburg', country: 'Germany', by: '+120 days', dl: '+21 days', status: 'open' });
  R(buyer2, u2, { title: 'S355 steel plates 20 mm', cat: 'Steel Plates & Coils', mat: 'Carbon Steel', grade: 'S355JR', spec: '2000 x 6000 mm, MTC 3.1', qty: 120, unit: 'tons', target: 700, inc: 'CFR', loc: 'Hamburg', country: 'Germany', by: '+60 days', dl: '+7 days', status: 'pending_review' });

  // A couple of quotations on the first RFQ
  const Q = (co, email, q) => {
    run(`INSERT INTO quotations(requirement_id,supplier_company_id,user_id,unit_price,currency,quantity,moq,lead_time_days,payment_terms,incoterm,validity_date,notes,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,date('now','+30 days'),?,?)`, r1, co, get('SELECT id FROM users WHERE email=?', email).id,
      q.price, 'USD', 2400, q.moq, q.lead, q.pay, 'CIF', q.notes, q.status);
    run("UPDATE rfq_invites SET status='quoted' WHERE requirement_id=? AND supplier_company_id=?", r1, co);
  };
  Q(s1, 'supplier@demo.com', { price: 112, moq: 200, lead: 60, pay: '30% advance, 70% against BL', notes: 'Includes machining, UT testing and 3.1 certificates. First article in 25 days.', status: 'submitted' });
  Q(s2, 'supplier2@demo.com', { price: 124, moq: 500, lead: 70, pay: 'LC at sight', notes: 'Castings through partner foundry, machining in-house.', status: 'pending_review' });

  // A sample conversation
  const t = run('INSERT INTO threads(requirement_id,company_a,company_b,subject) VALUES(?,?,?,?)', r1, buyer, s1, 'RFQ-' + (1000 + Number(r1)) + ' – technical clarification').lastInsertRowid;
  run('INSERT INTO messages(thread_id,sender_user_id,sender_company_id,body) VALUES(?,?,?,?)', t, u1, buyer, 'Can you confirm hardness range after machining and whether you can supply PPAP Level 3?');
  run('INSERT INTO messages(thread_id,sender_user_id,sender_company_id,body) VALUES(?,?,?,?)', t, get("SELECT id FROM users WHERE email='supplier@demo.com'").id, s1, 'Yes — 170–230 HB, and PPAP Level 3 documentation is included in the quoted price.');

  console.log('\nDemo data loaded. Logins (password Demo@1234):');
  console.log('  Buyer:    buyer@demo.com   |  buyer2@demo.com');
  console.log('  Supplier: supplier@demo.com | supplier2@demo.com | supplier3@demo.com | supplier4@demo.com');
}

module.exports = { ensureBase, INDUSTRIES };
if (require.main === module) demo();
