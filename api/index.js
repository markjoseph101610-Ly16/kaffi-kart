/* Hello Kaffi - ONE server for Vercel (REST API). Same endpoints and rules as the old backend-sync/server.js.
   What changed for Vercel (logic untouched): the JSON file db -> Firestore, in-memory sessions -> signed tokens,
   WebSocket -> /api/sync polling, proof images + sales-report CSVs -> Firestore.
   Local run: npm install && npm start -> http://localhost:3000   (POS: /pos/login.html) */
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const admin = require('firebase-admin');
// Optional local .env (project root). On Vercel use Project Settings -> Environment Variables instead.
(() => {
  for (const f of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
    try {
      const txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      txt.split(/\r?\n/).forEach(line => {
        if (/^\s*#/.test(line)) return;
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m) return;
        let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
        if (v) process.env[m[1]] = v;
      });
    } catch (e) { /* no local .env: fine on Vercel */ }
  }
})();
const nodemailer = require('nodemailer');

// Firebase Admin: verifies Google ID tokens AND is the database (Firestore).
// Credentials: env FIREBASE_SERVICE_ACCOUNT (the whole serviceAccountKey.json text, or its base64) -> or a local serviceAccountKey.json in the project root.
let SERVICE_ACCOUNT = null;
try {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) SERVICE_ACCOUNT = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  else if (fs.existsSync(path.join(__dirname, '..', 'serviceAccountKey.json'))) SERVICE_ACCOUNT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'serviceAccountKey.json'), 'utf8'));
  if (SERVICE_ACCOUNT && SERVICE_ACCOUNT.private_key) SERVICE_ACCOUNT.private_key = SERVICE_ACCOUNT.private_key.replace(/\\n/g, '\n');
  if (SERVICE_ACCOUNT) admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) });
} catch (e) { console.error('\n[!] Firebase service account is missing/invalid (' + e.message + ') - Google sign-in and the database will not work until FIREBASE_SERVICE_ACCOUNT is set.\n'); }

const PORT = process.env.PORT || 3000;
const MAX_PROOF_ATTEMPTS = 2;   // customer may send the GCash proof twice (1 retry)
/* Senior citizen discount (RA 9994): 20% off. If the shop is VAT-registered, set SENIOR_VAT_EXEMPT = true:
   the 12% VAT in the price is removed first, then 20% is taken off the VAT-free price. */
const SENIOR_RATE = 0.20, VAT_RATE = 0.12, SENIOR_VAT_EXEMPT = false;
const money = n => Math.round(n * 100) / 100;
function seniorPricing(subtotal) {
  const total = money(SENIOR_VAT_EXEMPT ? subtotal / (1 + VAT_RATE) * (1 - SENIOR_RATE) : subtotal * (1 - SENIOR_RATE));
  return { total, discount: money(subtotal - total) };
}
const COD_LIMIT = 500;                              // Terms section 5: Cash on Delivery only for orders of PHP 500 or less
const hash = p => crypto.scryptSync(p, 'hello-kaffi-salt', 32).toString('hex');

/* ---------- Real Hello Kaffi menu (prices in PHP) ---------- */
const buildMenu = () => {
  const m = [], add = (name, category, price, stock, desc = '') => m.push({ id: m.length + 1, name, category, price, stock, desc });
  const sized = (cat, list, stock) => list.forEach(([n, sm, lg]) => { if (sm) add(`${n} - Small`, cat, sm, stock); add(`${n} - Large`, cat, lg, stock); });
  add('Unli Wings, Drinks & Rice', 'Unlimited promos', 319, 60, '17 wing flavors with unlimited rice and drinks. Good for 2 hours.');
  add('Unli Wings, Pasta, Drinks & Rice', 'Unlimited promos', 349, 60, '17 wing flavors and 5 pasta variants, with unlimited rice and drinks.');
  add('Add-on: Unli Fries', 'Unlimited promos', 30, 60, 'Cheese, Hickory BBQ or Sour Cream. Add to the 349 promo.');
  add('Add-on: Unli Pasta & Fries', 'Unlimited promos', 60, 60, 'Add to the 319 wings promo.');
  add('Add-on: Unli Baby Back Ribs & Hungarian Sausage', 'Unlimited promos', 180, 60, 'Add to any unli promo.');
  [['6 pcs', 189], ['8 pcs', 250], ['12 pcs', 379], ['Sampler 24 pcs', 750], ['Party Tray 50 pcs', 1400]]
    .forEach(([n, p]) => add(`Fried Chicken Wings - ${n}`, 'Wings', p, 80, 'Smothered in house sauces. Put your flavor in the order notes (17 to choose from).'));
  const pastas = [
    ['Creamy Carbonara', 'Silky spaghetti with ham in a super creamy, cheesy sauce.'],
    ['Baked Penne', 'Al dente pasta, creamy marinara meat sauce, herbed cream and plenty of cheese.'],
    ['Kids Choice Spaghetti', 'Filipino-style spaghetti with hotdog meat sauce and cheese.'],
    ['Tuna Pesto', 'Pesto, garlic and tuna in olive oil, topped with parmesan.'],
    ['Pasta Ala Romana', 'Spanish sardines sauteed with garlic, basil, bell pepper and carrots.']];
  pastas.forEach(([n, d]) => [['Solo with Garlic Bread', 140], ['Good for 2', 230], ['Good for 5', 450], ['Tray', 860]].forEach(([sz, p]) => add(`${n} - ${sz}`, 'Pasta', p, 30, d)));
  [['Baby Back Ribs and Rice', 250], ['Pork Tonkatsu Rice', 170], ['Lechon Kawali Rice', 170], ['Pork Liempo Rice', 170], ['Fish Fillet Rice', 170],
   ['Spamsilog', 150], ['Bacsilog', 150], ['Tocilog', 150], ['Hungariansilog', 150],
   ['2 pcs Wings and Pasta', 200], ['Baby Back Ribs and Pasta', 350], ['Salisbury Steak', 170], ['Lechon Pares Rice', 190], ['Lechon Kare-Kare Rice', 200]]
    .forEach(([n, p]) => add(n, 'Rice Meals', p, 40, /silog$/.test(n) ? 'All-day breakfast.' : ''));
  [['Korean Chicken Rice Bowl', 'Unli rice. Flavors: Teriyaki, BBQ, Oriental, Cheesebomb, Sweet and Spicy.'], ['2 pcs Wings and Rice', 'Unli rice. Any wing flavor.'], ['2 pcs Pork BBQ and Rice', 'Unli rice.']]
    .forEach(([n, d]) => add(`Budget Meal: ${n}`, 'Rice Meals', 99, 40, d));
  add('Add-on: Unli Juice', 'Rice Meals', 30, 80, 'Add to any rice meal.');
  add('Set A (Good for 2)', 'Group Meals', 529, 20, '6 pcs wings, 2 solo pasta, 2 rice, 2 juice. P265 per head.');
  add('Set B (Good for 4-5)', 'Group Meals', 1200, 20, '16 pcs wings, 1 pasta platter, 4 rice, 1 solo fries, 1 pitcher juice. P240 per head.');
  add('Set C (Good for 3-4)', 'Group Meals', 1000, 20, '8 pcs wings, 2 solo pasta, pork tonkatsu, 4 rice, 1 pitcher juice. P250 per head.');
  add('Set D (Good for 5-6)', 'Group Meals', 1500, 20, '12 pcs wings, back ribs or BBQ liempo, sweet and sour fish fillet, lechon kawali, 5 rice, 1 pitcher juice. P250 per head.');
  add('Flavored Fries - Solo', 'Snacks & Sandwiches', 75, 60, 'Cheese, BBQ or Sour Cream.'); add('Flavored Fries - Group', 'Snacks & Sandwiches', 150, 60, 'Cheese, BBQ or Sour Cream.');
  add('Mojos and Dip - Solo', 'Snacks & Sandwiches', 140, 40, 'Real potato slices, cheese and dip.'); add('Mojos and Dip - Group', 'Snacks & Sandwiches', 400, 40, 'Real potato slices, cheese and dip.');
  add('Beef Nachos', 'Snacks & Sandwiches', 170, 40); add('Fries Overload', 'Snacks & Sandwiches', 170, 40, 'Fries topped with bite-sized chicken, drizzled with cheese.');
  add('Strawberry Waffle', 'Snacks & Sandwiches', 170, 40); add('Belgian Waffle Double', 'Snacks & Sandwiches', 130, 40);
  add('Nutella Filled Waffle', 'Snacks & Sandwiches', 170, 40); add('Chicken and Waffles', 'Snacks & Sandwiches', 200, 40);
  add('Chicken Fillet Sandwich', 'Snacks & Sandwiches', 145, 40, 'Deep fried chicken fillet with cheese sauce, mayo, cheese and lettuce. Add P50 for fries and drink.');
  add('Quarter Pounder Beef Burger with Cheese', 'Snacks & Sandwiches', 135, 40, 'Grilled 1/4 lb beef with cheese sauce, mayo, cheese and lettuce. Add P50 for fries and drink.');
  add('Club House Sandwich', 'Snacks & Sandwiches', 150, 40, 'Ham, egg and cheese.'); add('Bacon, Egg and Waffles', 'Snacks & Sandwiches', 229, 40, 'Crispy bacon, fried egg and kittea belgian waffle.');
  sized('Iced Coffee', [['Iced Americano', 70, 90], ['Iced Cafe Latte', 80, 100], ['Iced Hazelnut Coffee', 80, 100], ['Iced Caramel Macchiato', 80, 105], ['Iced Cafe Dark Mocha', 90, 115],
    ['Iced Matcha Latte', 0, 120], ['Iced Dirty Matcha', 0, 130], ['Iced Strawberry Matcha', 0, 140], ['Iced Choconut Latte', 0, 130], ['Iced Oreo Latte', 0, 130]], 80);
  sized('Hot Coffee', [['Hot Americano', 70, 90], ['Hot Cafe Latte', 80, 100], ['Hot Hazelnut Coffee', 80, 100], ['Hot Caramel Macchiato', 80, 105], ['Hot Cafe Dark Mocha', 90, 115],
    ['Hot Matcha Latte', 95, 120], ['Hot Dirty Matcha', 105, 130]], 80);
  ['Oreo Cheesecake Dark Choco', 'Oreo Cheesecake Red Velvet', 'Strawberry Cheesecake', 'Matcha Creamcheese', 'Okinawa Creamcheese', 'Real Creamcheese Nutella'].forEach(n => add(`${n} Milktea`, 'Milkteas', 120, 60, 'Large only.'));
  sized('Milkteas', [['Wintermelon Milktea', 65, 80], ['Okinawa Milktea', 65, 80], ['Taro Milktea', 70, 85], ['Strawberry Milktea', 70, 85], ['Chocolate Milktea', 70, 85]], 80);
  sized('Sodas & Drinks', [['Kiwi Fruit Soda', 85, 100], ['Green Apple Fruit Soda', 85, 100], ['Lychee Fruit Soda', 85, 100], ['Strawberry Fruit Soda', 85, 100]], 60);
  [['Soda in Can', 65], ['1.5L Soda', 130], ['Beer in Can', 90], ['Juice in Can', 70], ['Juice Pitcher', 100], ['Soda in Bottle', 35]].forEach(([n, p]) => add(n, 'Sodas & Drinks', p, 80));
  return m;
};
/* END MENU */

/* ---------- Database (swap for SQLite/Postgres/Firestore in production) ---------- */
/* Storage. Everything lives in the Firestore collection "kaffi" as small JSON docs:
     core (users, menu, riders, counters)  c_0..c_15 (customer accounts)  p_0..p_15 (google profiles)  o_<n> (orders, 100 ids per doc)
   plus kaffi_proofs (GCash proof images), kaffi_reports (sales CSVs, gzipped), kaffi_pending (OTP sign-ups).
   Without a Firebase key the same code uses a local file (.data/store.json) so you can still test on your own PC. */
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const makeStore = () => {
  /* SUPABASE: used when SUPABASE_URL + SUPABASE_SERVICE_KEY are set. Same JSON docs as Firestore, kept in the table public.kaffi_docs (col, id, data jsonb).
     Firebase Admin above is still used to verify Google sign-in tokens. */
  if (process.env.SUPABASE_URL && SB_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL.trim(), SB_KEY.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
    const T = 'kaffi_docs', fail = (what, error) => { throw new Error('Supabase ' + what + ': ' + error.message); };
    return {
      kind: 'supabase',
      async getDoc(col, id) { const { data, error } = await sb.from(T).select('data').eq('col', col).eq('id', id).maybeSingle(); if (error) fail('read', error); return data ? data.data : null; },
      async listDocs(col, fields) {
        const sel = fields ? 'id,' + fields.map(f => `${f}:data->${f}`).join(',') : 'id,data', out = [];
        for (let from = 0; ; from += 1000) {   // PostgREST returns max 1000 rows per request, so read in pages
          const { data, error } = await sb.from(T).select(sel).eq('col', col).order('id').range(from, from + 999); if (error) fail('list', error);
          data.forEach(r => out.push({ id: r.id, data: fields ? Object.fromEntries(fields.map(f => [f, r[f]])) : r.data }));
          if (data.length < 1000) break;
        }
        return out;
      },
      async findBy(col, field, value) { const { data, error } = await sb.from(T).select('id,data').eq('col', col).eq('data->>' + field, String(value)); if (error) fail('find', error); return data.map(r => ({ id: r.id, data: r.data })); },
      async commit(sets, dels) {
        for (let k = 0; k < sets.length; k += 100) {
          const rows = sets.slice(k, k + 100).map(x => ({ col: x.col, id: x.id, data: x.data, updated_at: new Date().toISOString() }));
          const { error } = await sb.from(T).upsert(rows, { onConflict: 'col,id' }); if (error) fail('write', error);
        }
        const byCol = {}; dels.forEach(x => (byCol[x.col] ||= []).push(x.id));
        for (const [col, ids] of Object.entries(byCol)) for (let k = 0; k < ids.length; k += 100) {
          const { error } = await sb.from(T).delete().eq('col', col).in('id', ids.slice(k, k + 100)); if (error) fail('delete', error);
        }
      }
    };
  }
  if (SERVICE_ACCOUNT) {
    const fdb = admin.firestore();
    return {
      kind: 'firestore',
      async getDoc(col, id) { const d = await fdb.collection(col).doc(id).get(); return d.exists ? d.data() : null; },
      async listDocs(col, fields) { let q = fdb.collection(col); if (fields) q = q.select(...fields); return (await q.get()).docs.map(d => ({ id: d.id, data: d.data() })); },
      async findBy(col, field, value) { return (await fdb.collection(col).where(field, '==', value).get()).docs.map(d => ({ id: d.id, data: d.data() })); },
      async commit(sets, dels) {
        const ops = [...sets.map(x => ['s', x]), ...dels.map(x => ['d', x])];
        for (let k = 0; k < ops.length; k += 400) {
          const b = fdb.batch();
          ops.slice(k, k + 400).forEach(([t, x]) => t === 's' ? b.set(fdb.collection(x.col).doc(x.id), x.data) : b.delete(fdb.collection(x.col).doc(x.id)));
          await b.commit();
        }
      }
    };
  }
  const file = path.join(__dirname, '..', '.data', 'store.json');
  let mem = {}; try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const persist = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(mem)); } catch (e) {} };
  const clone = x => JSON.parse(JSON.stringify(x));
  console.warn('[!] No Firebase key found: using the local file .data/store.json (testing only - Vercel needs SUPABASE_URL + SUPABASE_SERVICE_KEY).');
  return {
    kind: 'file',
    async getDoc(col, id) { return mem[col] && mem[col][id] ? clone(mem[col][id]) : null; },
    async listDocs(col, fields) { return Object.entries(mem[col] || {}).map(([id, d]) => ({ id, data: fields ? Object.fromEntries(fields.map(f => [f, d[f]])) : clone(d) })); },
    async findBy(col, field, value) { return Object.entries(mem[col] || {}).filter(([, d]) => d[field] === value).map(([id, d]) => ({ id, data: clone(d) })); },
    async commit(sets, dels) { sets.forEach(x => ((mem[x.col] ||= {})[x.id] = clone(x.data))); dels.forEach(x => mem[x.col] && delete mem[x.col][x.id]); persist(); }
  };
};
const store = makeStore();
const COL = 'kaffi', PROOFS = 'kaffi_proofs', REPORTS = 'kaffi_reports', PENDING = 'kaffi_pending';
const bucket = (k, n) => parseInt(crypto.createHash('sha1').update(String(k)).digest('hex').slice(0, 6), 16) % n;

const seed = () => ({
  seq: 1000,
  users: [
    { username: 'admin', role: 'admin', name: 'Kaffi Admin', pass: hash('admin123') },
    { username: 'cashier', role: 'cashier', name: 'Front Counter', pass: hash('cashier123') }
  ],
  menu: buildMenu(),
  menuVersion: 3,
  nextMenuId: 1000,
  orders: []
});
let db = null, loadedRev = -1, snap = new Map(), dirty = false;
const extraSets = [], extraDels = [];            // proof images / report files queued by a request, written in the same flush
const save = () => { dirty = true; };            // handlers call save() as before; the real write happens once, just before the response is sent
const orderDoc = id => 'o_' + Math.floor(id / 100);
function upgrade() {
// Upgrade older databases to the real Hello Kaffi menu (orders are kept).
if (db.menuVersion !== 3) { db.menu = buildMenu(); db.nextMenuId = 1000; db.menuVersion = 3; }
// Delivery riders (Hello Kaffi has 3). Rename them and add phone numbers from the Admin page.
if (!Array.isArray(db.riders)) db.riders = [1, 2, 3].map(n => ({ id: n, name: `Rider ${n}`, phone: '', onDuty: true }));
if (!db.codBans || typeof db.codBans !== 'object' || Array.isArray(db.codBans)) db.codBans = {};   // email -> timestamp until which cash-on-delivery is paused (3 cancels in 30 days)
if (!db.profiles || typeof db.profiles !== 'object' || Array.isArray(db.profiles)) db.profiles = {};   // Google customers: email -> { name, phone, address } (real name for delivery)
if (!Array.isArray(db.customers)) db.customers = [];   // customer accounts (username + password, Gmail verified by OTP)
db.nextRiderId = db.nextRiderId || (Math.max(0, ...db.riders.map(r => r.id)) + 1);
save();

}
async function loadAll(rev) {
  const docs = await store.listDocs(COL), by = {}; docs.forEach(d => (by[d.id] = d.data));
  const parse = n => (by[n] && by[n].json ? JSON.parse(by[n].json) : null);
  const core = parse('core');
  const next = core || seed();
  next.customers = []; next.profiles = {}; next.orders = [];
  snap = new Map();
  Object.keys(by).forEach(n => { if (n === 'rev') return; snap.set(n, by[n].json); const v = parse(n);
    if (/^c_/.test(n)) next.customers.push(...v); else if (/^p_/.test(n)) Object.assign(next.profiles, v); else if (/^o_/.test(n)) next.orders.push(...v); });
  next.orders.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);   // newest first, like live orders
  db = next; loadedRev = rev;
  if (!core) save();
  upgrade();
}
function serialize() {
  const out = new Map(), core = { ...db }; delete core.customers; delete core.profiles; delete core.orders;
  out.set('core', JSON.stringify(core));
  const grp = (prefix, items, keyFn, wrap) => { const g = {}; items.forEach(x => (g[prefix + keyFn(x)] ||= []).push(x)); Object.entries(g).forEach(([n, l]) => out.set(n, JSON.stringify(wrap(l)))); };
  grp('c_', db.customers, c => bucket(c.username, 16), l => l);
  const pg = {}; Object.entries(db.profiles).forEach(([e, p]) => ((pg['p_' + bucket(e, 16)] ||= {})[e] = p)); Object.entries(pg).forEach(([n, o]) => out.set(n, JSON.stringify(o)));
  grp('o_', db.orders, o => Math.floor(o.id / 100), l => l);
  out.forEach((j, n) => { if (j.length > 900000) throw new Error(`Database part "${n}" is too big for one Firestore document`); });
  return out;
}
async function refresh() {
  const rv = await store.getDoc(COL, 'rev'), rev = rv ? rv.n : 0;
  if (db && rev === loadedRev) return;            // nobody changed anything since this server last looked
  await loadAll(rev);
}
async function flush() {
  if (!dirty && !extraSets.length && !extraDels.length) return;
  const sets = extraSets.splice(0), dels = extraDels.splice(0);
  if (sets.length || dels.length) await store.commit(sets, []);   // proof / report files first, so an order never points at a missing file
  const wasDirty = dirty; dirty = false;
  if (wasDirty && db) {
    const now = serialize(), w = [], d = [];
    now.forEach((j, n) => { if (snap.get(n) !== j) w.push({ col: COL, id: n, data: { json: j } }); });
    snap.forEach((j, n) => { if (!now.has(n)) d.push({ col: COL, id: n }); });
    const rev = Math.max(Date.now(), Math.ceil(loadedRev) + 1) + Math.random();
    if (w.length || d.length) { w.push({ col: COL, id: 'rev', data: { n: rev } }); await store.commit(w, d.concat(dels)); loadedRev = rev; snap = now; }
  } else if (dels.length) await store.commit([], dels);
}
const queueProof = (name, ext, buf) => { if (buf.length > 700 * 1024) { const e = new Error('Proof image is too large (max 700 KB)'); e.status = 400; throw e; } extraSets.push({ col: PROOFS, id: name, data: { ext, b64: buf.toString('base64') } }); };
const pendingGet = async k => store.getDoc(PENDING, k);
const pendingSet = async (k, p) => store.commit([{ col: PENDING, id: k, data: p }], []);
const pendingDel = async k => store.commit([], [{ col: PENDING, id: k }]);
const pendingFindUser = async u => (await store.findBy(PENDING, 'username', u)).map(x => ({ key: x.id, p: x.data }));

/* ---------- App + sessions ---------- */
const app = express();
app.set('trust proxy', true);   // behind Vercel's proxy: real client IP for rate limiting
const jsonSmall = express.json({ limit: '3mb' }), jsonBig = express.json({ limit: '25mb' });
// 3mb: GCash proof arrives as a compressed data URL. The admin sales-report import may be much larger.
app.use((req, res, next) => (['/api/orders/import', '/api/reports/save'].includes(req.path) ? jsonBig : jsonSmall)(req, res, next));

// DEV: allow pages opened with VS Code Live Server (port 5500) to call this API
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && /^http:\/\/(localhost|127\.0\.0\.1):5500$/.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Stops the "Cross-Origin-Opener-Policy would block the window.closed call" warning
// from the Google sign-in popup.
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

/* Sessions are signed tokens (HMAC), so any Vercel instance can verify them - nothing is kept in server memory. */
const SECRET = process.env.SESSION_SECRET || (SERVICE_ACCOUNT ? crypto.createHash('sha256').update('hk-session|' + SERVICE_ACCOUNT.private_key).digest('hex') : 'local-dev-secret');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const b64u = b => Buffer.from(b).toString('base64url');
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const newSession = u => { const p = b64u(JSON.stringify({ u, iat: Date.now(), exp: Date.now() + SESSION_MS })); return p + '.' + sign(p); };
function readSession(tok) {
  const [p, sg] = String(tok || '').split('.'); if (!p || !sg) return null;
  const a = Buffer.from(sg), b = Buffer.from(sign(p)); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!d || !d.u || d.exp < Date.now()) return null;
  const u = { ...d.u };
  if (u.google) {   // Google customers: name/phone/address come from the saved profile; "confirmed" = they confirmed it AFTER this login (same as the old per-session flag)
    const pr = db && db.profiles[u.email];
    if (pr) Object.assign(u, { name: pr.name || u.name, phone: pr.phone || '', address: pr.address || '', hasProfile: !!pr.name });
    u.confirmed = !!(pr && pr.updatedAt >= d.iat);
  }
  return u;
}
const auth = (...roles) => (req, res, next) => {
  const s = readSession((req.headers.authorization || '').replace('Bearer ', ''));
  if (!s || (roles.length && !roles.includes(s.role))) return res.status(401).json({ error: 'Not authorized' });
  req.user = s; next();
};
/* Every /api request: load the latest data first, and save any change BEFORE the response is sent (Vercel freezes the function right after). */
app.use('/api', async (req, res, next) => {
  try { await refresh(); } catch (e) { console.error('db load failed:', e); return res.status(503).json({ error: 'Database is not available right now. Please try again.' }); }
  const end = res.end;
  res.end = function (...args) {
    res.end = end;
    flush().then(() => end.apply(res, args)).catch(e => {
      console.error('save failed:', e); db = null; loadedRev = -1;   // memory may be ahead of the database: reload on the next request
      if (res.headersSent) return end.apply(res, args);
      res.removeHeader('Content-Length'); res.removeHeader('ETag'); res.statusCode = e.status || 500; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      end.call(res, JSON.stringify({ error: e.status ? e.message : 'Could not save your change. Please try again.' }));
    });
    return res;
  };
  next();
});

/* ---------- Real-time sync ----------
   Vercel has no WebSockets: the pages poll GET /api/sync (public/realtime.js) and get the same menu / order / riders updates.
   broadcast() therefore does nothing; every save() bumps the "rev" counter that /api/sync compares. */
const broadcast = () => {};

/* ---------- Riders ----------
   "Assigned"    = has a delivery order that has not left yet
   "On delivery" = the cashier sent the order out
   "Returning"   = order delivered, but nobody has confirmed the rider is back yet
   "Free"        = back and available (after the admin or cashier presses "Rider returned")
   Nothing is toggled by hand except on/off duty (admin). */
const activeRiderOrder = rid => db.orders.find(o => o.type === 'delivery' && o.riderId === rid && o.status !== 'Completed' && o.status !== 'Cancelled');
const ridersState = () => db.riders.map(r => {
  const o = activeRiderOrder(r.id);
  return { ...r, orderId: o ? o.id : null, state: o ? (o.dispatched ? 'On delivery' : 'Assigned') : r.returning ? 'Returning' : (r.onDuty ? 'Free' : 'Off duty') };
});
const pushRiders = () => broadcast({ type: 'riders', riders: ridersState() });

/* ---------- Auth ---------- */
// Real Google sign-in: the browser signs in with Firebase, we verify the ID token here.
app.post('/api/auth/google', async (req, res) => {
  try {
    const d = await admin.auth().verifyIdToken(String((req.body || {}).idToken || ''));
    if (!d.email || !d.email_verified) return res.status(401).json({ error: 'Unverified Google account' });
    const email = d.email.toLowerCase(), pr = db.profiles[email] || {};
    // google:true + confirmed:false -> the shop page opens the "confirm your details" window before ordering is allowed.
    const user = { role: 'customer', google: true, confirmed: false, name: pr.name || d.name || d.email.split('@')[0], email, phone: pr.phone || '', address: pr.address || '', hasProfile: !!pr.name };
    res.json({ token: newSession(user), user });
  } catch (e) { console.error('Google verify failed:', e.code || '', e.message); res.status(401).json({ error: 'Invalid Google sign-in' }); }
});
// Real-name check: first + last name, letters only (rejects things like "acount123").
const realName = n => { const w = n.split(/\s+/); return n.length >= 4 && n.length <= 60 && w.length >= 2 && w.every(x => /^\p{L}[\p{L}.'’-]*$/u.test(x)) && w.some(x => x.replace(/[^\p{L}]/gu, '').length >= 2); };
app.post('/api/profile', auth('customer'), (req, res) => {
  if (!req.user.google) return res.status(400).json({ error: 'Only Google accounts need this step' });
  const b = req.body || {}, name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(b.phone || '').replace(/[\s-]/g, '').replace(/^\+?63/, '0'), address = String(b.address || '').trim().replace(/\s+/g, ' ');
  if (!realName(name)) return res.status(400).json({ error: 'Please enter your real first and last name (letters only, no numbers).' });
  if (!/^09\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid mobile number, like 09171234567.' });
  if (address.length < 10 || address.length > 200) return res.status(400).json({ error: 'Enter your complete delivery address (house no., street, barangay, city).' });
  db.profiles[req.user.email] = { name, phone, address, updatedAt: Date.now() }; save();
  Object.assign(req.user, { name, phone, address, confirmed: true, hasProfile: true });   // same object the session map holds
  res.json({ user: req.user });
});
app.post('/api/auth/staff', (req, res) => {
  const { username, password, role } = req.body || {};
  const u = db.users.find(x => x.username === username && x.pass === hash(String(password || '')));
  if (!u || u.role !== role) return res.status(401).json({ error: 'Wrong username, password or role' });
  const user = { role: u.role, name: u.name, email: u.username };
  res.json({ token: newSession(user), user });
});

/* ---------- Customer accounts: username + password, Gmail verified with a one-time code (OTP) ----------
   Register  -> POST /api/auth/register          (checks the form, emails a 6-digit code; NO account yet)
   Verify    -> POST /api/auth/register/verify   (right code -> account is created)
   Resend    -> POST /api/auth/register/resend
   Login     -> POST /api/auth/customer          (username + password)
   Email setup: set GMAIL_USER and GMAIL_APP_PASSWORD (a Google "App password", not your normal password).
   Without them the code is printed in this console instead (development only). */
const OTP_TTL = 10 * 60 * 1000, OTP_MAX_TRIES = 5, OTP_RESEND_MS = 60 * 1000;
const RESERVED_NAMES = ['admin', 'cashier', 'staff', 'root', 'hellokaffi'];
/* ---- Email sender: Brevo API (recommended, free 300/day) OR Gmail SMTP. Brevo is used if BREVO_API_KEY is set. ---- */
const https = require('https');
const brevoCall = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = https.request({ hostname: 'api.brevo.com', path, method, headers: Object.assign({ 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' }, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) }, resp => {
    let out = ''; resp.on('data', c => out += c);
    resp.on('end', () => resp.statusCode >= 200 && resp.statusCode < 300 ? resolve(out) : reject(new Error(`Brevo ${resp.statusCode}: ${out.slice(0, 300)}`)));
  });
  r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('Brevo request timed out'))); if (data) r.write(data); r.end();
});
let mailer = null, FROM_EMAIL = '';
if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER) {
  FROM_EMAIL = process.env.BREVO_SENDER;
  mailer = {
    sendMail: m => brevoCall('POST', '/v3/smtp/email', { sender: { name: 'Hello Kaffi', email: FROM_EMAIL }, to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text }),
    verify: () => brevoCall('GET', '/v3/account')
  };
} else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  FROM_EMAIL = process.env.GMAIL_USER;
  mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
}
if (!mailer) console.error('\n[!] No email sender configured in backend-sync/.env (set BREVO_API_KEY + BREVO_SENDER, or GMAIL_USER + GMAIL_APP_PASSWORD) - customer sign-up is DISABLED.\n');
else if (!process.env.VERCEL) mailer.verify()
  .then(() => console.log(`[OK] Email sender ready: verification codes will be emailed from ${FROM_EMAIL}`))
  .catch(e => console.error('\n[!] Email sender login FAILED - check the keys in backend-sync/.env. Reason:', e.message, '\n'));

const hits = new Map();      // simple per-IP rate limiting
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();   // pending sign-ups (key -> { email, name, username, pass, salt, otp, expires, tries, sentAt }) are kept in Firestore until verified
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, n = Date.now(), h = (hits.get(k) || []).filter(t => n - t < ms);
  if (h.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  h.push(n); hits.set(k, h); next();
};
const newPw = p => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex'); };   // per-user salt
const checkPw = (p, stored) => {
  const [salt, h] = String(stored || '').split(':'); if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(p, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const DUMMY_PW = newPw('not-a-real-password-1');   // so a wrong username takes as long as a wrong password
const otpHash = (code, salt) => crypto.createHash('sha256').update(salt + code).digest('hex');
const gmailKey = e => String(e).split('@')[0].split('+')[0].replace(/\./g, '') + '@gmail.com';   // Gmail ignores dots and +tags, so j.doe@ and jdoe@ are the same account
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendOtp(p) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  if (!mailer) { const err = new Error('Email is not configured'); err.notConfigured = true; throw err; }   // never print the code; it is only ever emailed
  await mailer.sendMail({
    from: `"Hello Kaffi" <${FROM_EMAIL}>`, to: p.email, subject: 'Your Hello Kaffi verification code',
    text: `Hi ${p.name},\n\nYour Hello Kaffi verification code is ${code}.\nIt expires in 10 minutes. If you did not sign up, you can ignore this email.\n\n- Hello Kaffi`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #f6d3e0;border-radius:14px">
      <h2 style="margin:0 0 8px;color:#f0458a">Hello Kaffi</h2><p>Hi ${escHtml(p.name)}, use this code to finish creating your account:</p>
      <p style="font-size:34px;letter-spacing:8px;font-weight:700;color:#3d2b2e;margin:18px 0">${code}</p>
      <p style="color:#8b7478;font-size:13px">It expires in 10 minutes. If you did not sign up, you can ignore this email.</p></div>`
  });
  p.salt = crypto.randomBytes(8).toString('hex'); p.otp = otpHash(code, p.salt);
  p.expires = Date.now() + OTP_TTL; p.tries = 0; p.sentAt = Date.now();
}

app.post('/api/auth/register', limit(8, 15 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const name = String(b.fullName || '').trim().replace(/\s+/g, ' '), username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || ''), email = String(b.email || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Please enter your full name' });
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, dot or underscore' });
  if (RESERVED_NAMES.includes(username)) return res.status(409).json({ error: 'That username is taken' });
  if (password.length < 8 || password.length > 72 || !/[a-z]/i.test(password) || !/\d/.test(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and a number' });
  if (!/^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/.test(email)) return res.status(400).json({ error: 'Please enter a valid Gmail address (name@gmail.com)' });
  const key = gmailKey(email);
  if (db.customers.some(c => c.username === username)) return res.status(409).json({ error: 'That username is taken' });
  if (db.customers.some(c => gmailKey(c.email) === key)) return res.status(409).json({ error: 'This Google account already has an account. Please log in.' });
  for (const x of await pendingFindUser(username)) if (x.key !== key && x.p.expires > Date.now()) return res.status(409).json({ error: 'That username is taken' });
  const p = { email, name, username, pass: newPw(password) };
  try { await sendOtp(p); }
  catch (e) { console.error('OTP email failed:', e.message); return res.status(502).json({ error: e.notConfigured ? 'Sign-up email is not set up yet. Please contact the shop.' : 'We could not send the email. Check the Gmail address and try again.' }); }
  await pendingSet(key, p);
  res.json({ ok: true, email, resendIn: OTP_RESEND_MS / 1000 });
});
app.post('/api/auth/register/verify', limit(20, 15 * 60 * 1000), async (req, res) => {
  const key = gmailKey((req.body || {}).email), code = String((req.body || {}).otp || '').trim(), p = await pendingGet(key);
  if (!p || p.expires < Date.now()) { await pendingDel(key); return res.status(400).json({ error: 'This code has expired. Please register again.' }); }
  if (p.tries >= OTP_MAX_TRIES) { await pendingDel(key); return res.status(429).json({ error: 'Too many wrong codes. Please register again.' }); }
  p.tries++; await pendingSet(key, p);
  const good = /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(otpHash(code, p.salt)), Buffer.from(p.otp));
  if (!good) return res.status(400).json({ error: `Wrong code. ${OTP_MAX_TRIES - p.tries} ${OTP_MAX_TRIES - p.tries === 1 ? 'try' : 'tries'} left.` });
  if (db.customers.some(c => c.username === p.username)) { await pendingDel(key); return res.status(409).json({ error: 'That username was just taken. Please register again.' }); }
  db.customers.push({ username: p.username, name: p.name, email: p.email, pass: p.pass, createdAt: Date.now() });
  save(); await pendingDel(key);
  res.json({ ok: true, username: p.username });
});
app.post('/api/auth/register/resend', limit(6, 15 * 60 * 1000), async (req, res) => {
  const pkey = gmailKey((req.body || {}).email), p = await pendingGet(pkey);
  if (!p) return res.status(400).json({ error: 'Registration expired. Please fill in the form again.' });
  const wait = p.sentAt + OTP_RESEND_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)}s before asking for a new code` });
  try { await sendOtp(p); } catch (e) { console.error('OTP resend failed:', e.message); return res.status(502).json({ error: 'We could not send the email. Please try again.' }); }
  await pendingSet(pkey, p);
  res.json({ ok: true, resendIn: OTP_RESEND_MS / 1000 });
});
app.post('/api/auth/customer', limit(15, 15 * 60 * 1000), (req, res) => {
  const b = req.body || {}, c = db.customers.find(x => x.username === String(b.username || '').trim().toLowerCase());
  const ok = checkPw(String(b.password || ''), c ? c.pass : DUMMY_PW);
  if (!c || !ok) return res.status(401).json({ error: 'Wrong username or password' });
  const user = { role: 'customer', name: c.name, email: c.email, username: c.username };
  res.json({ token: newSession(user), user });
});

/* ---------- Menu CRUD ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, store: (typeof store !== 'undefined' && store.kind) || 'unknown' }));
app.get('/api/menu', (req, res) => res.json(db.menu));
app.get('/api/config', auth('cashier', 'admin'), (req, res) => res.json({ seniorRate: SENIOR_RATE, seniorVatExempt: SENIOR_VAT_EXEMPT, vatRate: VAT_RATE }));
const cleanItem = b => ({ name: String(b.name || '').trim().slice(0, 80), category: String(b.category || '').trim(), price: Math.max(0, +b.price || 0), stock: Math.max(0, Math.floor(+b.stock || 0)), desc: String(b.desc || '').slice(0, 200) });
app.post('/api/menu', auth('admin'), (req, res) => {
  const it = cleanItem(req.body);
  if (!it.name || !it.category) return res.status(400).json({ error: 'Name and category required' });
  db.menu.push({ id: db.nextMenuId++, ...it }); save(); broadcast({ type: 'menu', menu: db.menu }); res.json(db.menu);
});
app.put('/api/menu/:id', auth('admin'), (req, res) => {
  const it = db.menu.find(m => m.id == req.params.id);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  Object.assign(it, cleanItem({ ...it, ...req.body })); save(); broadcast({ type: 'menu', menu: db.menu }); res.json(db.menu);
});
app.delete('/api/menu/:id', auth('admin'), (req, res) => {
  db.menu = db.menu.filter(m => m.id != req.params.id); save(); broadcast({ type: 'menu', menu: db.menu }); res.json(db.menu);
});

/* ---------- Orders (inventory is deducted atomically here) ---------- */
/* ---------- Cash-on-delivery abuse rules ----------
   1) Daily cap: all of a customer's unpaid (COD / pay-on-pickup) orders placed today add up to COD_LIMIT at most.
      Cancelled orders STILL COUNT, so order-cancel-order cannot get around the cap.
   2) Cancel strike: 3 customer-cancelled COD orders within 30 days -> COD is paused for 30 days (GCash only). */
const DAY_MS = 86400000, COD_BAN_CANCELS = 3, COD_BAN_DAYS = 30, PH_OFFSET = 8 * 3600000;
const phDayStart = t => Math.floor((t + PH_OFFSET) / DAY_MS) * DAY_MS - PH_OFFSET;   // midnight in the Philippines
function codStatus(email, now = Date.now()) {
  const mine = db.orders.filter(o => o.email === email && o.source === 'Online' && !/gcash/i.test(o.payment || ''));
  const usedToday = mine.filter(o => o.createdAt >= phDayStart(now)).reduce((s, o) => s + (+o.total || 0), 0);
  const until = db.codBans[email] || 0;
  const cancels = db.orders.filter(o => o.email === email && o.cancelReason === 'customer' && o.cancelledAt >= now - COD_BAN_DAYS * DAY_MS).length;   // strikes in the last 30 days
  return { banned: until > now, until, usedToday, left: Math.max(0, COD_LIMIT - usedToday), limit: COD_LIMIT, cancels, maxCancels: COD_BAN_CANCELS };
}
const phDate = t => new Date(t).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'long', day: 'numeric', year: 'numeric' });
app.get('/api/cod-status', auth('customer'), (req, res) => res.json(codStatus(req.user.email)));

app.post('/api/orders', auth('customer', 'cashier', 'admin'), (req, res) => {
  try { return placeOrder(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
});
function placeOrder(req, res) {
  const { items, type, address, note, payment } = req.body || {};
  const staff = req.user.role !== 'customer';
  if (!staff && req.user.google && !req.user.confirmed) return res.status(403).json({ error: 'Please confirm your name, mobile number and address first.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
  const orderType = staff ? 'walk-in' : (type === 'delivery' ? 'delivery' : 'pickup');
  if (orderType === 'delivery' && !String(address || '').trim()) return res.status(400).json({ error: 'Delivery address required' });
  const lines = [];
  for (const { id, qty } of items) {
    const m = db.menu.find(x => x.id == id), q = Math.floor(+qty);
    if (!m || !(q > 0)) return res.status(400).json({ error: 'Invalid item in cart' });
    if (m.stock < q) return res.status(409).json({ error: `Only ${m.stock} left of ${m.name}` });
    lines.push({ m, q });
  }
  /* ----- payment rules (customers only) ----- */
  const subtotal = lines.reduce((s, { m, q }) => s + m.price * q, 0);
  const gcash = !staff && String(payment || '').startsWith('GCash');
  let staffRef = '';
  if (staff) {   // the shop takes Cash and GCash only; a GCash sale needs its reference number (each reference can be used once)
    if (!['Cash', 'GCash'].includes(payment || 'Cash')) return res.status(400).json({ error: 'Payment must be Cash or GCash.' });
    if (payment === 'GCash') {
      staffRef = String(req.body.gcashRef || '').trim().slice(0, 40);
      if (staffRef.length < 4) return res.status(400).json({ error: 'Enter the GCash reference number.' });
      const used = db.orders.find(o => o.gcashRef && o.gcashRef.toLowerCase() === staffRef.toLowerCase() && o.status !== 'Cancelled');
      if (used) return res.status(409).json({ error: `That GCash reference number was already used on order #${used.id}.` });
    }
  }
  let proof = null;
  if (gcash) {
    const pm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.proof || ''));
    if (!pm) return res.status(400).json({ error: 'GCash proof of payment is required' });
    const buf = Buffer.from(pm[2], 'base64');
    if (buf.length > 700 * 1024) return res.status(400).json({ error: 'Proof image is too large (max 700 KB)' });
    if (!String(req.body.gcashRef || '').trim()) return res.status(400).json({ error: 'GCash reference number is required' });
    proof = { ext: pm[1], buf };
  } else if (!staff) {
    const cod = codStatus(req.user.email), name = orderType === 'delivery' ? 'Cash on delivery' : 'Pay on pick-up';   // same rules, wording follows the order type
    if (cod.banned) return res.status(403).json({ error: `${name} is paused on your account until ${phDate(cod.until)} because of repeated cancelled orders. Please pay with GCash.` });
    if (subtotal > COD_LIMIT) return res.status(400).json({ error: `${name} is only for orders of PHP ${COD_LIMIT} or less. Please pay with GCash.` });
    if (cod.usedToday + subtotal > COD_LIMIT) return res.status(400).json({ error: cod.left > 0 ? `${name} is limited to PHP ${COD_LIMIT} per day. You can still order up to PHP ${cod.left.toFixed(2)} today on cash, or pay this one with GCash.` : `You have reached the PHP ${COD_LIMIT} ${name.toLowerCase()} limit for today. Please pay with GCash.` });
  }
  /* ----- POS only: dine-in table number + senior citizen discount ----- */
  let service = '', table = '', discount = null, total = subtotal;
  if (staff) {
    service = req.body.service === 'take-out' ? 'take-out' : 'dine-in';
    if (service === 'dine-in') {   // a table number is for dine-in customers only
      table = String(req.body.table || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 \-]{0,5}$/.test(table)) return res.status(400).json({ error: 'Enter a table number for dine-in orders (letters or numbers, up to 6 characters).' });
    }
    if (req.body.senior) {   // the discount is only ever given to a senior citizen with an ID on record
      const idNumber = String(req.body.senior.id || '').trim().slice(0, 30);
      if (idNumber.length < 4) return res.status(400).json({ error: 'Enter the senior citizen ID number to give the discount.' });
      const p = seniorPricing(subtotal);
      discount = { type: 'Senior Citizen', rate: SENIOR_RATE, vatExempt: SENIOR_VAT_EXEMPT, idNumber, amount: p.discount }; total = p.total;
    }
  }
  // Node is single-threaded: this check + deduct is atomic within one process.
  lines.forEach(({ m, q }) => (m.stock -= q));
  const order = {
    id: ++db.seq, source: staff ? 'POS' : 'Online', type: orderType,
    customer: staff ? (req.body.customer || 'Walk-in') : req.user.name, email: staff ? null : req.user.email,
    phone: staff ? '' : (req.user.phone || ''),
    address: orderType === 'delivery' ? String(address).slice(0, 200) : '', note: String(note || '').slice(0, 200),
    payment: staff ? (payment || 'Cash') : (gcash ? 'GCash' : 'Pay on pickup/delivery'),
    gcashRef: gcash ? String(req.body.gcashRef).trim().slice(0, 40) : staffRef, proofFile: '', proofViewed: false, proofAttempts: gcash ? 1 : 0,
    items: lines.map(({ m, q }) => ({ id: m.id, name: m.name, price: m.price, qty: q })),
    subtotal, service, table, discount, total, status: gcash ? 'Payment Review' : 'Pending', createdAt: Date.now(),   // 'Payment Review' is skipped by the cashier's auto-accept
    riderId: null, riderName: '', dispatched: false
  };
  if (proof) { order.proofFile = order.id + '.' + proof.ext; queueProof(order.proofFile, proof.ext, proof.buf); }
  db.orders.unshift(order); save();
  broadcast({ type: 'order', order, isNew: true }, order.email);
  broadcast({ type: 'menu', menu: db.menu });
  res.json(order);
}
app.get('/api/orders', auth('cashier', 'admin'), (req, res) => res.json(db.orders));
app.get('/api/orders/mine', auth('customer'), (req, res) => res.json(db.orders.filter(o => o.email === req.user.email)));
app.patch('/api/orders/:id/status', auth('cashier', 'admin'), (req, res) => {
  const o = db.orders.find(x => x.id == req.params.id);
  if (!o || !['Pending', 'Preparing', 'Ready', 'Completed'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid request' });
  if (o.status === 'Payment Review') return res.status(409).json({ error: 'Check the GCash payment proof first' });
  if (o.status === 'Payment Retry') return res.status(409).json({ error: 'Waiting for the customer to send a new payment proof' });
  if (o.status === 'Cancelled') return res.status(409).json({ error: 'This order was cancelled' });
  if (req.body.status === 'Completed' && o.type === 'delivery' && !o.dispatched) return res.status(400).json({ error: 'Assign a rider and send the order out for delivery first' });
  if (req.body.status === 'Completed' && o.status !== 'Completed' && o.type === 'delivery' && o.riderId) {
    const r = db.riders.find(x => x.id === o.riderId); if (r) r.returning = true;   // delivered; rider is heading back
  }
  o.status = req.body.status; save(); broadcast({ type: 'order', order: o }, o.email); pushRiders(); res.json(o);
});

/* ---------- GCash proof review ---------- */
// The cashier opens the image through this route (needs the login token, so nobody else can see it).
app.get('/api/orders/:id/proof', auth('cashier', 'admin'), async (req, res) => {
  let o = db.orders.find(x => x.id == req.params.id);
  if (!o || !o.proofFile) return res.status(404).json({ error: 'No proof uploaded for this order' });
  const name = path.basename(o.proofFile), doc = await store.getDoc(PROOFS, name);
  if (!doc) return res.status(404).json({ error: 'Proof file is missing' });
  o = db.orders.find(x => x.id == req.params.id); if (o) { o.proofViewed = true; save(); }   // the server remembers that the cashier has seen it
  res.type('image/' + doc.ext).send(Buffer.from(doc.b64, 'base64'));
});
/* The customer re-sends the proof after the first rejection. Goes back to the cashier's "Payment check". */
app.post('/api/orders/:id/proof', auth('customer'), (req, res) => {
  const o = db.orders.find(x => x.id == req.params.id);
  if (!o || o.email !== req.user.email) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'Payment Retry') return res.status(409).json({ error: 'This order is not waiting for a new payment proof' });
  const pm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.proof || ''));
  if (!pm) return res.status(400).json({ error: 'GCash proof of payment is required' });
  const buf = Buffer.from(pm[2], 'base64');
  if (buf.length > 700 * 1024) return res.status(400).json({ error: 'Proof image is too large (max 700 KB)' });
  const ref = String(req.body.gcashRef || '').trim();
  if (!ref) return res.status(400).json({ error: 'GCash reference number is required' });
  const old = o.proofFile;
  o.proofFile = o.id + '-2.' + pm[1];
  queueProof(o.proofFile, pm[1], buf);
  if (old && old !== o.proofFile) extraDels.push({ col: PROOFS, id: path.basename(old) });
  o.gcashRef = ref.slice(0, 40); o.proofAttempts = MAX_PROOF_ATTEMPTS; o.proofViewed = false; o.status = 'Payment Review';
  save(); broadcast({ type: 'order', order: o }, o.email); res.json(o);
});

/* ---------- Customer cancels a COD order ----------
   Allowed only while the order is still 'Pending' (the cashier has not pressed "Mark as received" yet).
   Online GCash orders are never cancelled here. Stock goes back to the menu. */
const isCodOrder = o => o.source === 'Online' && !/gcash/i.test(o.payment || '');
app.patch('/api/orders/:id/cancel', auth('customer'), (req, res) => {
  const o = db.orders.find(x => x.id == req.params.id);
  if (!o || o.email !== req.user.email) return res.status(404).json({ error: 'Order not found' });
  if (!isCodOrder(o)) return res.status(409).json({ error: 'Only cash-on-delivery orders can be cancelled here.' });
  if (o.status === 'Cancelled') return res.status(409).json({ error: 'This order is already cancelled.' });
  if (o.status !== 'Pending') return res.status(409).json({ error: 'Too late to cancel: the cashier already received your order.' });
  o.status = 'Cancelled'; o.cancelReason = 'customer'; o.cancelledAt = Date.now();
  { const since = Date.now() - COD_BAN_DAYS * DAY_MS;   // strike system: too many cancelled COD orders pauses COD
    const n = db.orders.filter(x => x.email === o.email && x.cancelReason === 'customer' && x.cancelledAt >= since).length;
    if (n >= COD_BAN_CANCELS) db.codBans[o.email] = Date.now() + COD_BAN_DAYS * DAY_MS; }
  o.riderId = null; o.riderName = '';
  o.items.forEach(i => { const m = db.menu.find(x => x.id == i.id); if (m) m.stock += i.qty; });   // put the stock back
  save(); broadcast({ type: 'order', order: o }, o.email); broadcast({ type: 'menu', menu: db.menu }); pushRiders(); res.json(o);
});

/* ---------- Sales report files (admin) ----------
   save  -> writes a new CSV into REPORT_DIR (the file name is chosen here, never by the browser)
   list  -> the CSV files in REPORT_DIR, newest first
   read  -> returns one CSV from REPORT_DIR so the admin page can import it */
const REPORT_NAME = /^[\w][\w .()\-]*\.csv$/i;
const pad2 = n => String(n).padStart(2, '0');
const phStamp = () => {   // Philippine time, whatever timezone the server runs in
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}${p.second}`;
};
app.post('/api/reports/save', auth('admin'), (req, res) => {
  const csv = String((req.body && req.body.csv) || '');
  if (!csv.trim()) return res.status(400).json({ error: 'Nothing to save' });
  const label = String((req.body && req.body.label) || '').replace(/[^\w\-]/g, '').slice(0, 30);
  const name = `hello-kaffi-sales_${label ? label + '_' : ''}${phStamp()}.csv`;
  const text = '\ufeff' + csv.replace(/^\ufeff/, '');   // BOM so Excel reads UTF-8
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
  if (gz.length > 950000) return res.status(413).json({ error: 'This report is too big to store in one file. Export a shorter date range. Nothing was removed.' });
  extraSets.push({ col: REPORTS, id: name, data: { size: Buffer.byteLength(text), modified: Date.now(), gz } });
  /* Archive: the file is stored first (see flush), so the exported orders can now leave the system (re-import brings them back).
     Only finished orders are ever removed; anything still in progress stays. */
  let removed = 0;
  const ids = Array.isArray(req.body.archiveIds) ? new Set(req.body.archiveIds.map(Number)) : null;
  if (ids && ids.size) {
    const before = db.orders.length;
    db.orders = db.orders.filter(o => !(ids.has(o.id) && ['Completed', 'Cancelled'].includes(o.status)));
    removed = before - db.orders.length; save();
  }
  res.json({ name, folder: 'Sales-Report', removed });
});
app.get('/api/reports', auth('admin'), async (req, res) => {
  try {
    const docs = await store.listDocs(REPORTS, ['size', 'modified']);
    const files = docs.filter(d => REPORT_NAME.test(d.id)).map(d => ({ name: d.id, size: d.data.size, modified: d.data.modified })).sort((a, b) => b.modified - a.modified);
    res.json({ folder: 'Sales-Report', files });
  } catch (e) { res.status(500).json({ error: 'Could not read the Sales-Report folder' }); }
});
app.get('/api/reports/:name', auth('admin'), async (req, res) => {
  const name = path.basename(String(req.params.name));
  if (name !== req.params.name || !REPORT_NAME.test(name)) return res.status(400).json({ error: 'Invalid file name' });
  const doc = await store.getDoc(REPORTS, name);
  if (!doc) return res.status(404).json({ error: 'File not found in the Sales-Report folder' });
  res.type('text/plain; charset=utf-8').send(zlib.gunzipSync(Buffer.from(doc.gz, 'base64')).toString('utf8'));
});

/* ---------- Sales report import (admin) ----------
   The admin page turns an exported CSV back into order objects and sends them here.
   - Only finished orders (Completed / Cancelled) are imported; stock is NOT touched and nothing shows on the cashier board.
   - An order already in the system (same id and same date/time, to the minute) is skipped, so importing twice never doubles the sales.
   - If an id is already used by a different order, the imported one gets a fresh id. */
const IMPORT_FINAL = ['Completed', 'Cancelled'];
function importOrders(list) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n), num = v => (Number.isFinite(+v) ? +v : 0);
  const out = { added: 0, duplicates: 0, renumbered: 0, skipped: 0 };
  db.seq = db.orders.reduce((m, o) => Math.max(m, o.id), db.seq);   // never hand out an id that is already used
  for (const r of list) {
    if (!r || typeof r !== 'object') { out.skipped++; continue; }
    const status = str(r.status, 20), createdAt = Math.floor(num(r.createdAt));
    const items = (Array.isArray(r.items) ? r.items : []).map(i => ({ id: Math.floor(num(i && i.id)), name: str(i && i.name, 120), price: Math.max(0, num(i && i.price)), qty: Math.floor(num(i && i.qty)) })).filter(i => i.name && i.qty > 0);
    if (!IMPORT_FINAL.includes(status) || !(createdAt > 0) || !items.length) { out.skipped++; continue; }   // in-progress / unreadable rows
    let id = Math.floor(num(r.id));
    const same = id > 0 && db.orders.find(o => o.id === id);
    if (same && Math.abs(same.createdAt - createdAt) < 60000) { out.duplicates++; continue; }   // within a minute = same order (Excel drops the seconds when it re-saves)
    if (!(id > 0) || same) { id = ++db.seq; out.renumbered++; } else if (id > db.seq) db.seq = id;
    const source = r.source === 'POS' ? 'POS' : 'Online', payment = str(r.payment, 40);
    const type = ['delivery', 'pickup', 'walk-in'].includes(r.type) ? r.type : (source === 'POS' ? 'walk-in' : 'pickup');
    db.orders.push({
      id, source, type, customer: str(r.customer, 60) || 'Walk-in', email: str(r.email, 100).toLowerCase() || null,
      address: str(r.address, 200), note: str(r.note, 200), payment,
      gcashRef: str(r.gcashRef, 40), proofFile: '', proofViewed: false, proofAttempts: 0,
      service: ['dine-in', 'take-out'].includes(r.service) ? r.service : '', table: str(r.table, 6),
      subtotal: Math.max(0, num(r.subtotal)) || items.reduce((t, i) => t + i.price * i.qty, 0),
      discount: r.discount && num(r.discount.amount) > 0 ? { type: 'Senior Citizen', rate: SENIOR_RATE, vatExempt: SENIOR_VAT_EXEMPT, idNumber: str(r.discount.idNumber, 30), amount: money(num(r.discount.amount)) } : null,
      items, total: Math.max(0, num(r.total)) || items.reduce((t, i) => t + i.price * i.qty, 0),
      status, createdAt, cancelReason: status === 'Cancelled' ? str(r.cancelReason, 30) : undefined,
      paid: status === 'Completed' && /gcash/i.test(payment),
      riderId: null, riderName: str(r.riderName, 60), dispatched: type === 'delivery' && status === 'Completed', imported: true
    });
    out.added++;
  }
  db.orders.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);   // newest first, like live orders
  return out;
}
app.post('/api/orders/import', auth('admin'), (req, res) => {
  const list = req.body && req.body.orders;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'No orders found in the file' });
  if (list.length > 50000) return res.status(400).json({ error: 'Too many orders in one file (max 50,000)' });
  const out = importOrders(list); save(); res.json(out);
});

// decision: approve -> kitchen, reject -> cancelled + stock returned + customer alerted. Only after the proof was viewed.
app.patch('/api/orders/:id/payment', auth('cashier', 'admin'), (req, res) => {
  const o = db.orders.find(x => x.id == req.params.id);
  if (!o || o.status !== 'Payment Review') return res.status(400).json({ error: 'This order is not waiting for a payment check' });
  if (!o.proofViewed) return res.status(400).json({ error: 'View the payment proof first' });
  const d = (req.body || {}).decision;
  if (d === 'approve') { o.status = 'Preparing'; o.paid = true; }
  else if (d === 'reject' && (o.proofAttempts || 1) < MAX_PROOF_ATTEMPTS) {
    /* first rejection: give the customer one more chance to send a real receipt (stock stays reserved) */
    o.status = 'Payment Retry'; o.proofViewed = false;
  }
  else if (d === 'reject') {
    o.status = 'Cancelled'; o.cancelReason = 'fake_proof'; o.paid = false;
    o.riderId = null; o.riderName = '';
    o.items.forEach(i => { const m = db.menu.find(x => x.id == i.id); if (m) m.stock += i.qty; });   // put the stock back
    broadcast({ type: 'menu', menu: db.menu });
  } else return res.status(400).json({ error: 'Invalid decision' });
  o.paymentCheckedBy = req.user.name; o.paymentCheckedAt = Date.now();
  save(); broadcast({ type: 'order', order: o }, o.email); pushRiders(); res.json(o);
});

/* ---------- Delivery: riders + dispatch ---------- */
app.get('/api/riders', auth('cashier', 'admin'), (req, res) => res.json(ridersState()));
const cleanRider = b => ({ name: String(b.name || '').trim().slice(0, 40), phone: String(b.phone || '').trim().slice(0, 30) });
app.post('/api/riders', auth('admin'), (req, res) => {
  const r = cleanRider(req.body || {});
  if (!r.name) return res.status(400).json({ error: 'Rider name required' });
  db.riders.push({ id: db.nextRiderId++, ...r, onDuty: true }); save(); pushRiders(); res.json(ridersState());
});
app.put('/api/riders/:id', auth('admin'), (req, res) => {
  const r = db.riders.find(x => x.id == req.params.id);
  if (!r) return res.status(404).json({ error: 'Rider not found' });
  const b = req.body || {};
  if (b.name !== undefined) { const c = cleanRider(b); if (!c.name) return res.status(400).json({ error: 'Rider name required' }); r.name = c.name; }
  if (b.phone !== undefined) r.phone = cleanRider(b).phone;
  if (typeof b.onDuty === 'boolean') r.onDuty = b.onDuty;
  // keep the rider's name on their active orders up to date
  db.orders.filter(o => o.riderId === r.id && o.status !== 'Completed').forEach(o => { o.riderName = r.name; broadcast({ type: 'order', order: o }, o.email); });
  save(); pushRiders(); res.json(ridersState());
});
app.delete('/api/riders/:id', auth('admin'), (req, res) => {
  const r = db.riders.find(x => x.id == req.params.id);
  if (!r) return res.status(404).json({ error: 'Rider not found' });
  if (activeRiderOrder(r.id)) return res.status(409).json({ error: `${r.name} still has an active delivery` });
  db.riders = db.riders.filter(x => x.id !== r.id); save(); pushRiders(); res.json(ridersState());
});
// ADMIN + CASHIER: confirm a rider has come back, so they can take the next delivery.
app.patch('/api/riders/:id/returned', auth('cashier', 'admin'), (req, res) => {
  const r = db.riders.find(x => x.id == req.params.id);
  if (!r) return res.status(404).json({ error: 'Rider not found' });
  if (activeRiderOrder(r.id)) return res.status(409).json({ error: `${r.name} still has an active delivery` });
  r.returning = false; save(); pushRiders(); res.json(ridersState());
});
// ADMIN + CASHIER: assign (or unassign with riderId null) a rider to a delivery order. Only free, on-duty riders can be picked.
app.patch('/api/orders/:id/rider', auth('cashier', 'admin'), (req, res) => {
  const o = db.orders.find(x => x.id == req.params.id);
  if (!o || o.type !== 'delivery') return res.status(400).json({ error: 'Not a delivery order' });
  if (o.status === 'Completed') return res.status(409).json({ error: 'Order already delivered' });
  if (o.dispatched) return res.status(409).json({ error: 'Order is already out for delivery' });
  const rid = (req.body || {}).riderId;
  if (rid === null || rid === undefined || rid === '') { o.riderId = null; o.riderName = ''; }
  else {
    const r = db.riders.find(x => x.id == rid);
    if (!r) return res.status(404).json({ error: 'Rider not found' });
    if (!r.onDuty) return res.status(409).json({ error: `${r.name} is off duty` });
    if (r.returning) return res.status(409).json({ error: `${r.name} has not returned yet` });
    const busy = activeRiderOrder(r.id);
    if (busy && busy.id !== o.id) return res.status(409).json({ error: `${r.name} is already on order #${busy.id}` });
    o.riderId = r.id; o.riderName = r.name;
  }
  save(); broadcast({ type: 'order', order: o }, o.email); pushRiders(); res.json(o);
});
// CASHIER: the rider leaves with the order. Needs a rider assigned by the admin first.
app.patch('/api/orders/:id/dispatch', auth('cashier', 'admin'), (req, res) => {
  const o = db.orders.find(x => x.id == req.params.id);
  if (!o || o.type !== 'delivery') return res.status(400).json({ error: 'Not a delivery order' });
  if (o.status !== 'Ready') return res.status(409).json({ error: 'Order is not ready yet' });
  if (!o.riderId) return res.status(409).json({ error: 'The admin has not assigned a rider yet' });
  if (o.dispatched) return res.json(o);
  o.dispatched = true; o.dispatchedAt = Date.now();
  save(); broadcast({ type: 'order', order: o }, o.email); pushRiders(); res.json(o);
});

/* ---------- Sales ---------- */
app.get('/api/sales', auth('admin'), (req, res) => {
  const start = phDayStart(Date.now()), today = db.orders.filter(o => o.createdAt >= start && o.status !== 'Cancelled');
  const top = {}; today.forEach(o => o.items.forEach(i => (top[i.name] = (top[i.name] || 0) + i.qty)));
  res.json({
    revenue: today.reduce((s, o) => s + o.total, 0), count: today.length,
    online: today.filter(o => o.source === 'Online').length, pos: today.filter(o => o.source === 'POS').length,
    top: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5)
  });
});

/* ---------- Real-time replacement: the pages poll this (see public/realtime.js) ---------- */
app.get('/api/sync', auth(), (req, res) => {
  if (String(req.query.rev) === String(loadedRev)) return res.json({ same: true, rev: loadedRev });
  const staff = req.user.role !== 'customer';
  res.json({ rev: loadedRev, menu: db.menu, orders: staff ? db.orders : db.orders.filter(o => o.email === req.user.email), riders: staff ? ridersState() : undefined });
});

app.use('/api', (err, req, res, next) => {   // body-parser / unexpected errors -> JSON instead of an HTML page
  if (res.headersSent) return next(err);
  res.status(err.status || err.statusCode || 500).json({ error: err.type === 'entity.too.large' ? 'That upload is too large.' : (err.status && err.status < 500 ? err.message : 'Server error') });
});

/* One-time helper used by scripts/migrate-from-old.js: copies the old db.json / proofs / sales reports into Firestore. */
app.importLegacy = async ({ legacy, proofs = [], reports = [], force = false }) => {
  await refresh();
  if (!force && (db.customers.length || db.orders.length)) throw new Error('Firestore already has customers/orders. Run again with --force to overwrite.');
  Object.assign(db, legacy);
  db.orders = Array.isArray(legacy.orders) ? legacy.orders : [];
  db.orders.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  upgrade(); save();
  proofs.forEach(p => extraSets.push({ col: PROOFS, id: p.name, data: { ext: p.ext, b64: p.buf.toString('base64') } }));
  reports.forEach(r => extraSets.push({ col: REPORTS, id: r.name, data: { size: Buffer.byteLength(r.text), modified: r.modified, gz: zlib.gzipSync(Buffer.from(r.text, 'utf8')).toString('base64') } }));
  await flush();
  return { orders: db.orders.length, customers: db.customers.length, profiles: Object.keys(db.profiles).length, proofs: proofs.length, reports: reports.length };
};

module.exports = app;

// Local run only (npm start). On Vercel the exported app is the serverless function and public/ is served by the CDN.
if (require.main === module) {
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.listen(PORT, () => console.log(`Hello Kaffi running: http://localhost:${PORT}  |  POS: http://localhost:${PORT}/pos/login.html`));
}
