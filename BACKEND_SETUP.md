# ToolFlow PDF Backend — Complete Hosting Guide

## What You're Deploying
- **Frontend:** Your existing Netlify site (toolflow-pro.netlify.app)
- **Backend:** Node.js + Express API (handles all PDF operations)
- **Backend Host:** Render.com (FREE tier — Docker support included)

The backend uses:
- `pdf-lib` — merge, split, compress, rotate, watermark, crop, organize, page numbers, unlock, repair, sign, redact (works without Docker)
- `LibreOffice` — Word/Excel/PowerPoint conversions (requires Docker)
- `poppler-utils / ghostscript` — PDF to JPG, OCR (requires Docker)
- `qpdf` — Password protection (requires Docker)
- `Puppeteer/Chromium` — HTML to PDF (requires Docker)
- `tesseract.js` — OCR text extraction (requires Docker)

---

## PART 1 — Deploy Backend on Render.com (FREE)

### Step 1: Push backend to GitHub

```bash
cd toolflow-backend
git init
git add .
git commit -m "ToolFlow PDF backend v1"
git branch -M main
```

Go to GitHub.com → New repository → name it `toolflow-pdf-backend` → Copy the URL, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/toolflow-pdf-backend.git
git push -u origin main
```

### Step 2: Create a Render.com account
- Go to https://render.com
- Sign up FREE (use GitHub login)

### Step 3: Create a New Web Service on Render

1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub account
3. Select the `toolflow-pdf-backend` repository
4. Configure:

| Setting | Value |
|---------|-------|
| **Name** | toolflow-pdf-api |
| **Region** | Singapore (closest to Sri Lanka) |
| **Branch** | main |
| **Runtime** | **Docker** ← VERY IMPORTANT |
| **Plan** | Free |

5. Click **"Create Web Service"**
6. Wait 5–10 minutes for first build (Dockerfile installs LibreOffice etc.)

### Step 4: Get your backend URL
After deploy, Render gives you a URL like:
```
https://toolflow-pdf-api.onrender.com
```
**Copy this URL — you need it in Step 5.**

---

## PART 2 — Connect Frontend to Backend

### Step 5: Edit pdf-tools.html

Open `pdf-tools.html` and find this line near the top of the `<script>` section:

```javascript
const PDF_API = window.PDF_API_URL || 'https://YOUR-BACKEND.onrender.com';
```

Replace with your actual Render URL:
```javascript
const PDF_API = window.PDF_API_URL || 'https://toolflow-pdf-api.onrender.com';
```

### Step 6: Redeploy Netlify
1. ZIP your entire `toolsite` folder (all .html files, robots.txt, sitemap.xml)
2. Go to https://app.netlify.com
3. Click your site → **Deploys** tab
4. Drag the new ZIP onto the deploy area
5. Wait ~30 seconds

---

## PART 3 — Test Everything

Open https://toolflow-pro.netlify.app/pdf-tools.html and test:

### Tools that work immediately (no Docker needed):
- ✅ Merge PDF
- ✅ Split PDF
- ✅ Compress PDF
- ✅ Rotate PDF
- ✅ Watermark PDF
- ✅ Crop PDF
- ✅ Add Page Numbers
- ✅ Organize PDF
- ✅ Sign PDF (text signature)
- ✅ Unlock PDF
- ✅ Repair PDF
- ✅ Redact PDF
- ✅ PDF to PDF/A (basic)
- ✅ JPG to PDF
- ✅ Compare PDF
- ✅ Translate PDF

### Tools that need Docker (enabled on Render):
- ⚙️ PDF to Word / PowerPoint / Excel (LibreOffice)
- ⚙️ Word / PowerPoint / Excel to PDF (LibreOffice)
- ⚙️ PDF to JPG (poppler-utils)
- ⚙️ OCR PDF (Tesseract + poppler)
- ⚙️ HTML to PDF (Puppeteer)
- ⚙️ Protect PDF (qpdf)

All Docker tools are enabled when you deploy with the Docker runtime on Render.

---

## PART 4 — Known Issue: Render Free Tier "Cold Starts"

Free Render services go to sleep after 15 minutes of inactivity.
First request after sleep = **~30 second delay.**

**Fix:** Add a "warming" ping. In `pdf-tools.html` add to the `<script>` section:

```javascript
// Wake up backend on page load
setTimeout(() => fetch(PDF_API + '/').catch(() => {}), 500);
```

Or upgrade to Render Starter ($7/month) to eliminate cold starts.

---

## PART 5 — File Size Limits

The backend accepts files up to **50 MB**. For larger files:
1. Edit `server.js` and `routes/pdf.js` — change `50 * 1024 * 1024` to a larger number
2. Note: Render free tier may timeout on very large files (60 second limit)

---

## PART 6 — Custom Domain (Optional)

If you buy a domain later (e.g. toolflow.com):
1. In Netlify → Domain settings → Add custom domain
2. In Render → Your service → Settings → Custom Domains

---

## PART 7 — Troubleshooting

### "Network error" on all tools
→ Backend is asleep. Wait 30 seconds and retry.
→ Check that PDF_API URL in pdf-tools.html matches your Render URL exactly.

### "LibreOffice" / "needDocker" error
→ Make sure you chose **Docker** runtime when creating the Render service (not Node).
→ Re-create the service with Docker if needed.

### CORS error in browser console
→ Check that your Netlify URL is spelled correctly.
→ The backend allows all origins by default so this should not happen.

### Render build fails
→ Check Render logs (click your service → Logs tab)
→ Common fix: make sure `package.json` is in the root of your GitHub repo

---

## Summary — What to do RIGHT NOW

1. `cd toolflow-backend` → push to GitHub
2. Create Render service → choose **Docker** runtime → deploy
3. Copy the Render URL → paste into `pdf-tools.html`
4. Re-ZIP frontend → drag to Netlify
5. Test at toolflow-pro.netlify.app/pdf-tools.html
6. Submit updated sitemap in Google Search Console

That's it! Total time: ~20 minutes.
