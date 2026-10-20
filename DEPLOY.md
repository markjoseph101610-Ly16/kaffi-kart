# Deploy Hello Kaffi: GitHub -> Vercel + Render, Supabase DB, Firebase Google sign-in

## 1. Supabase (once)
1. Supabase dashboard > SQL Editor > paste `supabase/schema.sql` > Run.
2. (Optional) copy your old data: `npm install` then `npm run migrate -- "C:\path\to\CASE STUDY"` with SUPABASE_URL + SUPABASE_SECRET_KEY in `.env`.

## 2. GitHub (account: markjoseph101610@gmail.com)
Fresh start (recommended, drops the old account's email from history). Run inside the project folder:
```
rmdir /s /q .git          (Windows CMD; in Git Bash use: rm -rf .git)
git init
git config user.name "markjoseph101610-Ly16"
git config user.email "markjoseph101610@gmail.com"
git add .
git commit -m "Hello Kaffi: Supabase + Vercel + Render"
git branch -M main
git remote add origin https://github.com/markjoseph101610-Ly16/kaffi-kart.git
git push -u origin main
```
When Git asks you to sign in, log in as the markjoseph101610 account (browser popup, or a Personal Access Token as the password).
`.env` is git-ignored, so your keys are not uploaded.

## 3. Environment variables (same on Vercel AND Render)
| Name | Value |
|---|---|
| SUPABASE_URL | https://sjsifuhuifxqrgahcwtj.supabase.co |
| SUPABASE_SECRET_KEY | your (rotated) sb_secret_... key |
| FIREBASE_SERVICE_ACCOUNT | full serviceAccountKey.json (Firebase > Project settings > Service accounts > Generate new private key) |
| BREVO_API_KEY | your Brevo key |
| BREVO_SENDER | your verified Brevo sender email |
| SESSION_SECRET | one long random string, identical on both hosts |

## 4. Vercel
Add New > Project > import `kaffi-kart` > Framework: Other > add the variables above > Deploy.

## 5. Render
New > Web Service > connect `kaffi-kart` > Build `npm install`, Start `npm start`, Node 20 > add the variables > Create. (Or New > Blueprint, which reads `render.yaml`.)
Check: open `https://<your-service>.onrender.com/api/health` -> should show `"store":"supabase"`.

## 6. Firebase > Authentication > Settings > Authorized domains
Add the exact hostnames, with NO https:// and NO paths:
- your-project.vercel.app
- your-service.onrender.com   (note the dot before onrender.com)

## 7. Brevo
Security > Authorized IPs > deactivate IP blocking. Vercel and Render use changing IPs, so otherwise OTP emails fail with 401.
