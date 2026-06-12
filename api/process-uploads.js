// Automatic screenshot transcription. Walks data.pendingUploads, reads each screenshot
// with Claude (vision + structured outputs), validates the numbers against FIELD_RULES,
// appends the measurement, and resolves the upload — replacing the manual
// `npm run pull-uploads` + eyeball + addEntry flow.
//
// GET/POST /api/process-uploads   -> { ok: true, results: [{ id, status, ... }] }
//
// Triggered two ways: a Vercel cron (see vercel.json) as the safety net, and a
// fire-and-forget call from api/upload.js right after each upload lands.
//
// Failure handling: an upload that can't be transcribed (unreadable image, values out
// of range, unsupported format, API error) stays in pendingUploads with a
// transcribeError note so a human can fall back to `npm run pull-uploads`. After
// MAX_ATTEMPTS automatic tries it is left alone for good.
import Anthropic from '@anthropic-ai/sdk';
import { get } from '@vercel/blob';
import { cleanEntry, errorStatus, loadData, sortEntries, writeData } from './dataset.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const MAX_ATTEMPTS = 3;
// Claude API caps base64 images at ~5MB; leave headroom.
const MAX_API_IMAGE_BYTES = 4.5 * 1024 * 1024;

const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const nullable = (type, description) => ({ anyOf: [{ type }, { type: 'null' }], description });

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    readable: {
      type: 'boolean',
      description:
        'true only if this is a body-composition reading (InBody scan, smart scale, etc.) with at least one legible measurement',
    },
    date: nullable('string', 'Scan/measurement date shown in the image, as YYYY-MM-DD. null if not visible.'),
    source: nullable('string', "Device or app name shown, e.g. 'InBody' or 'Scale'. null if unclear."),
    weight: nullable('number', 'Body weight in POUNDS. Convert from kg if needed (1 kg = 2.20462 lb).'),
    bodyFatPct: nullable('number', 'Body fat percentage, e.g. 11.7'),
    skeletalMuscle: nullable('number', 'Skeletal muscle mass in POUNDS. Convert from kg if needed.'),
    bodyFatMass: nullable('number', 'Body fat mass in POUNDS. Convert from kg if needed.'),
    bmi: nullable('number', 'BMI if shown'),
    note: nullable('string', 'Anything worth flagging: unit conversion performed, partially legible values, ambiguity.'),
  },
  required: ['readable', 'date', 'source', 'weight', 'bodyFatPct', 'skeletalMuscle', 'bodyFatMass', 'bmi', 'note'],
  additionalProperties: false,
};

const PROMPT = `This screenshot is a body-composition reading (InBody scan, smart scale app, or similar) for one person.

Extract the measurements into the schema. Rules:
- Report weight, skeletal muscle mass, and body fat mass in POUNDS. If the reading is metric, convert (1 kg = 2.20462 lb) and mention the conversion in note.
- Use null for any value not shown or not legible. Never guess a digit you cannot read.
- date is the measurement date shown in the image (YYYY-MM-DD), not today's date. null if absent.
- If the image is not a body-composition reading at all, or no measurement is legible, set readable to false.`;

function validDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function readBlobBytes(upload) {
  for (const candidate of [upload.blobPath, upload.url].filter(Boolean)) {
    try {
      const r = await get(candidate, { access: 'private', useCache: false });
      if (r && r.statusCode === 200 && r.stream) {
        return Buffer.from(await new Response(r.stream).arrayBuffer());
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function mediaTypeFor(upload) {
  const fromContentType = String(upload.contentType || '').toLowerCase();
  if (Object.values(MEDIA_TYPES).includes(fromContentType)) return fromContentType;
  const ext = String(upload.blobPath || '').split('.').pop().toLowerCase();
  return MEDIA_TYPES[ext] || null;
}

// Returns { ok: true, extraction } or { ok: false, error, permanent }.
async function transcribeUpload(upload) {
  const mediaType = mediaTypeFor(upload);
  if (!mediaType) {
    return { ok: false, permanent: true, error: 'unsupported image format (heic/heif?) — transcribe manually' };
  }

  const bytes = await readBlobBytes(upload);
  if (!bytes || !bytes.length) return { ok: false, permanent: false, error: 'blob not found or empty' };
  if (bytes.length > MAX_API_IMAGE_BYTES) {
    return { ok: false, permanent: true, error: 'image too large for transcription — transcribe manually' };
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    return { ok: false, permanent: true, error: 'model declined to read this image' };
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let extraction;
  try {
    extraction = JSON.parse(text);
  } catch {
    return { ok: false, permanent: false, error: 'unparseable model output' };
  }
  if (!extraction.readable) {
    return { ok: false, permanent: true, error: extraction.note || 'image not readable as a body-composition screenshot' };
  }
  return { ok: true, extraction };
}

function buildEntry(upload, extraction) {
  const date = validDateString(extraction.date)
    ? extraction.date
    : String(upload.uploadedAt || '').slice(0, 10);
  const noteParts = ['Auto-transcribed by Claude from screenshot'];
  if (extraction.note) noteParts.push(extraction.note);

  // Deterministic id keyed to the upload so a cron/upload-trigger race can't double-add.
  return cleanEntry({
    id: `e-upload-${upload.id}`,
    person: upload.person,
    date,
    source: extraction.source || 'Screenshot',
    weight: extraction.weight,
    bodyFatPct: extraction.bodyFatPct,
    skeletalMuscle: extraction.skeletalMuscle,
    bodyFatMass: extraction.bodyFatMass,
    bmi: extraction.bmi,
    note: noteParts.join(' — '),
  });
}

export async function processPendingUploads() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { processed: false, error: 'ANTHROPIC_API_KEY is not set' };
  }

  const data = await loadData({ seed: false });
  const pending = data.pendingUploads || [];
  if (!pending.length) return { processed: true, results: [] };

  const results = [];
  let changed = false;
  const resolved = new Set();

  for (const upload of pending) {
    if (data.entries.some((e) => e.id === `e-upload-${upload.id}`)) {
      resolved.add(upload.id);
      changed = true;
      results.push({ id: upload.id, status: 'already-added' });
      continue;
    }
    if ((upload.transcribeAttempts || 0) >= MAX_ATTEMPTS) {
      results.push({ id: upload.id, status: 'gave-up', error: upload.transcribeError });
      continue;
    }

    let outcome;
    try {
      outcome = await transcribeUpload(upload);
    } catch (e) {
      outcome = { ok: false, permanent: false, error: String((e && e.message) || e) };
    }

    if (outcome.ok) {
      const entry = buildEntry(upload, outcome.extraction);
      if (entry) {
        data.entries.push(entry);
        resolved.add(upload.id);
        changed = true;
        results.push({ id: upload.id, status: 'added', entry });
        continue;
      }
      outcome = { ok: false, permanent: true, error: 'extracted values failed validation (out of range?)' };
    }

    upload.transcribeAttempts = outcome.permanent ? MAX_ATTEMPTS : (upload.transcribeAttempts || 0) + 1;
    upload.transcribeError = outcome.error;
    changed = true;
    results.push({ id: upload.id, status: 'failed', error: outcome.error });
  }

  if (changed) {
    data.pendingUploads = pending.filter((u) => !resolved.has(u.id));
    sortEntries(data);
    await writeData(data);
  }
  return { processed: true, results };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the env var is set.
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    // 200 even when no API key is configured — transcription may be running locally
    // instead (tools/transcribe-uploads.mjs); don't make the daily cron look like an outage.
    const result = await processPendingUploads();
    return res.status(200).json({ ok: !result.error, ...result });
  } catch (e) {
    return res.status(errorStatus(e)).json({ error: String((e && e.message) || e) });
  }
}
