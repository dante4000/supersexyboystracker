// Transcribe pending screenshots locally via Claude Code headless mode (`claude -p`),
// so transcription runs on a Claude subscription — no ANTHROPIC_API_KEY needed.
//
//   npm run transcribe-uploads
//
// For each pending upload: download the screenshot from the private Blob, have Claude
// read the numbers, validate them with the same cleanEntry rules as the API, append the
// measurement to tracker/data.json, and clear the pending upload. Unreadable images stay
// pending (retried up to MAX_ATTEMPTS, then left for `npm run pull-uploads` manual entry).
//
// Reads BLOB_READ_WRITE_TOKEN from .env.local (or the environment). Schedule with the
// launchd plist in tools/ to run automatically — see README.
import { get } from '@vercel/blob';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEntry, loadData, sortEntries, writeData } from '../api/dataset.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_ATTEMPTS = 3;

async function loadEnv() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const txt = await readFile(join(ROOT, '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local — rely on real env */ }
}

async function downloadUpload(upload, dir) {
  for (const candidate of [upload.blobPath, upload.url].filter(Boolean)) {
    try {
      const r = await get(candidate, { access: 'private', useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) continue;
      const ext = String(upload.blobPath || 'x.png').split('.').pop().toLowerCase();
      let local = join(dir, `${upload.id}.${ext}`);
      await writeFile(local, Buffer.from(await new Response(r.stream).arrayBuffer()));
      // Claude can't read HEIC — convert with macOS sips.
      if (ext === 'heic' || ext === 'heif') {
        const png = join(dir, `${upload.id}.png`);
        const conv = spawnSync('sips', ['-s', 'format', 'png', local, '--out', png], { encoding: 'utf8' });
        if (conv.status !== 0) throw new Error('HEIC conversion failed');
        local = png;
      }
      return local;
    } catch { /* try next candidate */ }
  }
  return null;
}

function prompt(imagePath) {
  return `Use the Read tool to look at the image file at ${imagePath}. It is a screenshot of a body-composition reading (InBody scan, smart scale app, or similar) for one person.

Respond with ONLY a raw JSON object — no markdown fences, no commentary — in this exact shape:
{"readable": boolean, "date": string|null, "source": string|null, "weight": number|null, "bodyFatPct": number|null, "skeletalMuscle": number|null, "bodyFatMass": number|null, "bmi": number|null, "note": string|null}

Rules:
- weight, skeletalMuscle, and bodyFatMass are in POUNDS. If the reading is metric, convert (1 kg = 2.20462 lb) and mention the conversion in note.
- Use null for any value not shown or not legible. Never guess a digit you cannot read.
- date is the measurement date shown IN the image (YYYY-MM-DD), null if absent — not today's date.
- If the image is not a body-composition reading, or no measurement is legible, set readable to false.`;
}

function transcribeWithClaude(imagePath) {
  const res = spawnSync(
    'claude',
    ['-p', prompt(imagePath), '--output-format', 'json', '--allowedTools', 'Read'],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${String(res.stderr || '').slice(0, 300)}`);
  const wrapper = JSON.parse(res.stdout);
  const text = typeof wrapper.result === 'string' ? wrapper.result : '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in claude output');
  return JSON.parse(m[0]);
}

function buildEntry(upload, x) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') ? x.date : String(upload.uploadedAt || '').slice(0, 10);
  const noteParts = ['Auto-transcribed by Claude from screenshot'];
  if (x.note) noteParts.push(x.note);
  return cleanEntry({
    id: `e-upload-${upload.id}`, // deterministic — re-runs can't double-add
    person: upload.person,
    date,
    source: x.source || 'Screenshot',
    weight: x.weight,
    bodyFatPct: x.bodyFatPct,
    skeletalMuscle: x.skeletalMuscle,
    bodyFatMass: x.bodyFatMass,
    bmi: x.bmi,
    note: noteParts.join(' — '),
  });
}

async function main() {
  await loadEnv();
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Missing BLOB_READ_WRITE_TOKEN (set it in .env.local or the environment).');
    process.exit(1);
  }

  const data = await loadData({ seed: false });
  const pending = data.pendingUploads || [];
  if (!pending.length) {
    console.log('No pending uploads. ✨');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'sst-uploads-'));
  const resolved = new Set();
  let changed = false;

  try {
    for (const upload of pending) {
      const tag = `${upload.person} ${upload.uploadedAt} (${upload.id})`;

      if (data.entries.some((e) => e.id === `e-upload-${upload.id}`)) {
        resolved.add(upload.id);
        changed = true;
        console.log(`= ${tag}: entry already exists, clearing upload`);
        continue;
      }
      if ((upload.transcribeAttempts || 0) >= MAX_ATTEMPTS) {
        console.log(`! ${tag}: gave up after ${MAX_ATTEMPTS} attempts (${upload.transcribeError || 'unknown'}) — use npm run pull-uploads`);
        continue;
      }

      let entry = null;
      let error = null;
      try {
        const local = await downloadUpload(upload, dir);
        if (!local) throw new Error('blob not found');
        const x = transcribeWithClaude(local);
        if (!x.readable) {
          error = x.note || 'image not readable as a body-composition screenshot';
        } else {
          entry = buildEntry(upload, x);
          if (!entry) error = 'extracted values failed validation (out of range?)';
        }
      } catch (e) {
        error = String((e && e.message) || e);
      }

      if (entry) {
        data.entries.push(entry);
        resolved.add(upload.id);
        changed = true;
        console.log(`+ ${tag}: added ${entry.date} bf ${entry.bodyFatPct ?? '—'}% wt ${entry.weight ?? '—'}`);
      } else {
        upload.transcribeAttempts = (upload.transcribeAttempts || 0) + 1;
        upload.transcribeError = error;
        changed = true;
        console.log(`✗ ${tag}: ${error} (attempt ${upload.transcribeAttempts}/${MAX_ATTEMPTS})`);
      }
    }

    if (changed) {
      data.pendingUploads = pending.filter((u) => !resolved.has(u.id));
      sortEntries(data);
      await writeData(data);
      console.log('Saved tracker/data.json — dashboard updates on next load.');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
