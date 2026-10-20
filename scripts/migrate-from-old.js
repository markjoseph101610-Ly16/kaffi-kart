/* One-time: copy your OLD data (backend-sync/db.json, proofs/, Sales-Report/*.csv) into Firestore so nothing is lost.
   Usage (run on your PC, inside this project folder, after `npm install`):
     node scripts/migrate-from-old.js "C:\path\to\CASE STUDY"
   Add --force to overwrite data that is already in Firestore. */
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), force = args.includes('--force'), old = args.find(a => !a.startsWith('--'));
if (!old) { console.error('Give the path of your old "CASE STUDY" folder.'); process.exit(1); }
const dbFile = path.join(old, 'backend-sync', 'db.json');
if (!fs.existsSync(dbFile)) { console.error('Cannot find ' + dbFile); process.exit(1); }
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {   // use the old key file if you did not set the env var
  const k = path.join(old, 'backend-sync', 'serviceAccountKey.json');
  if (fs.existsSync(k)) process.env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(k, 'utf8');
}
const app = require('../api/index.js');
const legacy = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const proofDir = path.join(old, 'backend-sync', 'proofs'), repDir = path.join(old, 'pos-admin-portal', 'Sales-Report');
const proofs = fs.existsSync(proofDir) ? fs.readdirSync(proofDir).filter(f => /\.(jpeg|png|webp)$/i.test(f)).map(f => ({ name: f, ext: f.split('.').pop().toLowerCase(), buf: fs.readFileSync(path.join(proofDir, f)) })) : [];
const reports = fs.existsSync(repDir) ? fs.readdirSync(repDir).filter(f => /\.csv$/i.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(repDir, f), 'utf8'), modified: fs.statSync(path.join(repDir, f)).mtimeMs })) : [];
app.importLegacy({ legacy, proofs, reports, force }).then(r => { console.log('Done:', r); process.exit(0); }).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
