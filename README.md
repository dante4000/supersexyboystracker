# Super Sexy Boys · Body Tracker

A dead-simple two-person body recomposition dashboard (Daniel + Kevin). Goal: drive
body-fat % down and watch the trend.

## What it does
- **Scorecards** — each person's latest body-fat %, change since baseline, and weight /
  muscle / fat-mass / BMI, plus a goal progress bar.
- **Trend chart** — body-fat % over time for both (toggle to weight / muscle / fat mass / BMI),
  with dashed goal lines.
- **History table** — every logged measurement, newest first.
- **Three ways to add data:**
  1. The **Log a measurement** form (type the numbers in).
  2. **Upload a screenshot** (InBody / scale) — it's stashed privately and transcribed later.
  3. Just tell Claude the numbers and they get added.

## Stack
Static HTML/CSS/JS + Vercel serverless functions + Vercel Blob (private). No build step.

- `index.html`, `styles.css`, `app.js` — the dashboard.
- `api/data.js` — GET the dataset / POST mutations (`addEntry`, `updateEntry`, `deleteEntry`,
  `setGoal`, `resolveUpload`). Stored at Blob `tracker/data.json` (private).
- `api/upload.js` — receives raw screenshot bytes → Blob `tracker/uploads/...` (private) and
  records a pending upload.
- `tools/pull-uploads.mjs` — `npm run pull-uploads` downloads pending screenshots to
  `data/uploads/` so the numbers can be read and entered.

## Setup (to go live)
1. Create a Vercel project rooted at this folder.
2. Add a **Blob** store and set `BLOB_READ_WRITE_TOKEN` (for local dev, put it in `.env.local`).
3. Deploy. The dataset seeds itself with the two baseline readings on first GET.

The dashboard reads and writes straight to the API; if a save fails it surfaces an error and
re-syncs from the server rather than keeping a stale local copy.

## Processing uploaded screenshots
```
npm install
npm run pull-uploads          # downloads pending shots to data/uploads/
# read the numbers, then add them (form, or POST addEntry), then clear:
# POST /api/data { "action": "resolveUpload", "id": "<upload id>" }
```
