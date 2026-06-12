import { get, put } from '@vercel/blob';

export const DATA_PATH = 'tracker/data.json';
export const MAX_DATA_BYTES = 4 * 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 128 * 1024;

export const DEFAULT_DATA = {
  version: 1,
  people: {
    daniel: { name: 'Daniel', accent: '#5EC343', goalBf: null },
    kevin: { name: 'Kevin', accent: '#F4801A', goalBf: null },
  },
  entries: [
    {
      id: 'seed-daniel-1',
      person: 'daniel',
      date: '2026-06-02',
      source: 'InBody',
      weight: 135.1,
      bodyFatPct: 11.7,
      skeletalMuscle: 67.5,
      bodyFatMass: 15.9,
      bmi: 20.2,
      note: 'Baseline InBody scan',
    },
    {
      id: 'seed-daniel-2',
      person: 'daniel',
      date: '2026-06-03',
      source: 'InBody',
      weight: 133.6,
      bodyFatPct: 10.6,
      skeletalMuscle: 67.7,
      bodyFatMass: 14.1,
      bmi: 19.9,
      note: 'InBody scan',
    },
    {
      id: 'seed-kevin-1',
      person: 'kevin',
      date: '2026-05-28',
      source: 'Scale',
      weight: 152.7,
      bodyFatPct: 17.4,
      skeletalMuscle: null,
      bodyFatMass: null,
      bmi: null,
      note: 'Baseline, consumer scale (after morning pee) - likely reads off',
    },
  ],
  pendingUploads: [],
};

const FIELD_RULES = {
  weight: { min: 1, max: 1000 },
  bodyFatPct: { min: 0, max: 75 },
  skeletalMuscle: { min: 0, max: 500 },
  bodyFatMass: { min: 0, max: 500 },
  bmi: { min: 5, max: 100 },
};

export const FIELDS = Object.keys(FIELD_RULES);

export function cloneDefaultData() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

export function httpError(message, code = 400) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Node system errors carry string codes ('ECONNRESET'); only trust numeric HTTP ones.
export function errorStatus(e) {
  const code = e && e.code;
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
}

function parseJsonText(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const body = req.body;
  if (Buffer.isBuffer(body)) return parseJsonText(body.toString('utf8'));
  if (body instanceof Uint8Array) return parseJsonText(Buffer.from(body).toString('utf8'));
  if (typeof body === 'string') return parseJsonText(body);
  if (body && typeof body === 'object') return body;

  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw httpError('request body too large', 413);
    chunks.push(c);
  }
  return parseJsonText(Buffer.concat(chunks).toString('utf8'));
}

function isBlobNotFound(e) {
  return e && (e.name === 'BlobNotFoundError' || /not.?found/i.test(String(e.message)));
}

export async function readStoredData() {
  let result = null;
  try {
    result = await get(DATA_PATH, { access: 'private', useCache: false });
  } catch (e) {
    if (isBlobNotFound(e)) return null;
    throw e;
  }
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  try { return normalizeData(JSON.parse(text)); } catch { return null; }
}

export async function writeData(data) {
  const normalized = normalizeData(data);
  const payload = JSON.stringify(normalized);
  if (Buffer.byteLength(payload, 'utf8') > MAX_DATA_BYTES) {
    throw httpError('dataset too large', 413);
  }
  await put(DATA_PATH, payload, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    addRandomSuffix: false,
  });
}

export async function loadData({ seed = false } = {}) {
  const stored = await readStoredData();
  if (stored) return stored;

  const seeded = cloneDefaultData();
  if (seed) await writeData(seeded);
  return seeded;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

export function compareEntries(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.person !== b.person) return compareText(a.person, b.person);
  return compareText(a.id, b.id);
}

export function sortEntries(data) {
  data.entries.sort(compareEntries);
  return data;
}

function cleanPendingUpload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const person = raw.person === 'kevin' ? 'kevin' : raw.person === 'daniel' ? 'daniel' : null;
  const blobPath = String(raw.blobPath || raw.pathname || '').trim();
  if (!person || !blobPath) return null;
  return {
    id: String(raw.id || `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 80),
    person,
    blobPath,
    uploadedAt: String(raw.uploadedAt || new Date().toISOString()).slice(0, 40),
    bytes: Number.isFinite(Number(raw.bytes)) ? Number(raw.bytes) : null,
    url: raw.url ? String(raw.url) : undefined,
    contentType: raw.contentType ? String(raw.contentType).slice(0, 80) : undefined,
    // Auto-transcription bookkeeping (see api/process-uploads.js).
    transcribeAttempts: Number.isInteger(raw.transcribeAttempts) ? raw.transcribeAttempts : undefined,
    transcribeError: raw.transcribeError ? String(raw.transcribeError).slice(0, 200) : undefined,
  };
}

export function normalizeData(raw) {
  const out = raw && typeof raw === 'object' ? raw : cloneDefaultData();
  out.version = 1;
  out.people = {
    daniel: { ...DEFAULT_DATA.people.daniel, ...(out.people && out.people.daniel) },
    kevin: { ...DEFAULT_DATA.people.kevin, ...(out.people && out.people.kevin) },
  };
  for (const person of Object.values(out.people)) {
    const goal = Number(person.goalBf);
    person.goalBf = Number.isFinite(goal) && goal > 0 && goal <= 75 ? goal : null;
  }
  out.entries = Array.isArray(out.entries) ? out.entries : [];
  out.pendingUploads = Array.isArray(out.pendingUploads)
    ? out.pendingUploads.map(cleanPendingUpload).filter(Boolean)
    : [];
  return sortEntries(out);
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function cleanString(value, fallback, max) {
  const s = String(value ?? '').trim();
  return (s || fallback).slice(0, max);
}

function cleanNumber(value, rule) {
  if (value == null) return { ok: true, value: null };
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < rule.min || n > rule.max) return { ok: false, value: null };
  return { ok: true, value: n };
}

// Keep only fields we recognise; coerce numbers; never trust client blindly.
export function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const person = raw.person === 'kevin' ? 'kevin' : raw.person === 'daniel' ? 'daniel' : null;
  if (!person) return null;
  const date = String(raw.date || '').trim();
  if (!validDate(date)) return null;

  const out = {
    id: cleanString(raw.id || `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, '', 80),
    person,
    date,
    source: cleanString(raw.source, 'Manual', 24),
    note: cleanString(raw.note, '', 240),
  };

  let hasMeasurement = false;
  for (const f of FIELDS) {
    const n = cleanNumber(raw[f], FIELD_RULES[f]);
    if (!n.ok) return null;
    out[f] = n.value;
    if (n.value != null) hasMeasurement = true;
  }
  return hasMeasurement ? out : null;
}

// One scan often arrives as several screenshots (different InBody screens), each yielding
// a partial entry. Fold an auto-transcribed entry into an existing same-person/same-date
// auto entry when no field conflicts; otherwise append it. Returns the surviving entry.
export function addOrMergeAutoEntry(data, entry) {
  const target = data.entries.find(
    (e) =>
      String(e.id).startsWith('e-upload-') &&
      e.person === entry.person &&
      e.date === entry.date &&
      FIELDS.every((f) => e[f] == null || entry[f] == null || e[f] === entry[f]),
  );
  if (!target) {
    data.entries.push(entry);
    return entry;
  }
  for (const f of FIELDS) {
    if (target[f] == null) target[f] = entry[f];
  }
  if (target.source === 'Screenshot' && entry.source !== 'Screenshot') target.source = entry.source;
  target.note = 'Auto-transcribed by Claude from screenshots';
  return target;
}

export function cleanGoal(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 75) return { ok: false, value: null };
  return { ok: true, value: n };
}
