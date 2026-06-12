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
- `api/upload.js` — receives raw screenshot bytes → Blob `tracker/uploads/...` (private),
  records a pending upload, and kicks off automatic transcription in the background.
- `api/process-uploads.js` — reads each pending screenshot with Claude (vision +
  structured outputs), validates the numbers, adds the entry, and clears the upload.
  Runs right after each upload and on a daily cron as a safety net.
- `tools/pull-uploads.mjs` — `npm run pull-uploads` downloads pending screenshots to
  `data/uploads/` so the numbers can be read and entered (manual fallback).

## Setup (to go live)
1. Create a Vercel project rooted at this folder.
2. Add a **Blob** store and set `BLOB_READ_WRITE_TOKEN` (for local dev, put it in `.env.local`).
3. Deploy. The dataset seeds itself with the two baseline readings on first GET.
4. Pick a transcription mode (below): local via Claude Code (subscription, no API key)
   or serverless via the Claude API (`ANTHROPIC_API_KEY`).

The dashboard reads and writes straight to the API; if a save fails it surfaces an error and
re-syncs from the server rather than keeping a stale local copy.

## Screenshot transcription

Both modes do the same thing: Claude reads the pending screenshot, the numbers are
range-checked against the same rules as manual entry, the measurement is added (note:
"Auto-transcribed by Claude"), and the pending upload is cleared. The dashboard reads
live from `/api/data`, so the new point appears on next load — no redeploy. Unreadable
images stay pending with a `transcribeError`, retried up to 3 times, then left for
manual entry.

### Mode A — local via Claude Code (subscription, no API key)
`tools/transcribe-uploads.mjs` downloads pending screenshots and runs `claude -p`
(headless Claude Code) to read each one — usage is covered by a Claude subscription.
Needs `BLOB_READ_WRITE_TOKEN` in `.env.local` (copy it from the Vercel Blob store) and
the `claude` CLI logged in.

```
npm run transcribe-uploads          # run once

# run automatically every 15 min via launchd:
cp tools/com.supersexyboystracker.transcribe.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.supersexyboystracker.transcribe.plist
# logs: /tmp/supersexyboystracker-transcribe.log
```

### Mode B — serverless via the Claude API (needs an API key with credits)
Set `ANTHROPIC_API_KEY` in Vercel and uploads are transcribed seconds after they land
(`api/upload.js` triggers `api/process-uploads.js` in the background; a daily cron in
`vercel.json` is the safety net — tighten it on a Pro plan, e.g. `*/5 * * * *`).
Optional: `CLAUDE_MODEL` (defaults to `claude-opus-4-8`), `CRON_SECRET` (locks the
endpoint to the cron). Without the key this mode is dormant and harmless.

### Manual fallback

```
npm install
npm run pull-uploads          # downloads pending shots to data/uploads/
# read the numbers, then add them (form, or POST addEntry), then clear:
# POST /api/data { "action": "resolveUpload", "id": "<upload id>" }
```
