# Hello Kaffi (customer site + POS/Admin + API sa isang project)

```
public/            <- customer site (/) at POS/Admin (/pos/login.html)
api/index.js       <- backend (Vercel serverless function)
scripts/           <- migrate-from-old.js (isang beses lang gamitin)
vercel.json  package.json  .env.example  .gitignore
```

## 1. I-upload sa GitHub
I-upload ang buong folder na ito. **Huwag** isama ang `.env` at `serviceAccountKey.json` (naka-.gitignore na sila).

## 2. I-deploy sa Vercel
1. Vercel > Add New > Project > piliin ang GitHub repo.
2. Framework Preset: **Other**. Walang build command. (Naka-set na sa `vercel.json`.)
3. Environment Variables (Settings > Environment Variables), tapos Redeploy:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | buong laman ng `serviceAccountKey.json` (paste as is) |
| `BREVO_API_KEY` | galing sa dati mong `backend-sync/.env` |
| `BREVO_SENDER` | galing sa dati mong `backend-sync/.env` |
| `SESSION_SECRET` | optional, kahit anong mahabang random text |

## 3. Firebase (hello-kaffi-hybrid)
- **Firestore Database** > Create database (Native mode) kung wala pa. Dito na naka-save ang menu, orders, accounts, GCash proofs at sales reports (wala nang db.json).
- **Authentication > Settings > Authorized domains** > idagdag ang Vercel domain mo (`xxxx.vercel.app`). Kung hindi, hindi gagana ang Google sign-in.

## 4. Ilipat ang lumang data (optional pero recommended)
Para hindi mawala ang accounts, orders, menu edits, proofs at sales reports mo:
```
npm install
node scripts/migrate-from-old.js "C:\path\to\CASE STUDY"
```
(Kukunin nito ang `db.json`, `proofs/` at `Sales-Report/` ng lumang folder at ilalagay sa Firestore.)

## Local test
`npm install` > ilagay ang values sa `.env` (tingnan ang `.env.example`) > `npm start` > http://localhost:3000
Kung walang Firebase key, gagamit ito ng local file `.data/store.json` (pang-test lang).
