// Body recomposition dataset, stored as a single private Vercel Blob (tracker/data.json).
// Two people (Daniel + Kevin), a flat list of measurement entries, and a list of
// screenshot uploads still pending manual processing.
//
// GET  /api/data                              -> full dataset (seeded if none yet)
// POST /api/data { action: "addEntry", entry }      -> append a measurement
// POST /api/data { action: "updateEntry", entry }   -> replace by id
// POST /api/data { action: "deleteEntry", id }      -> remove by id
// POST /api/data { action: "setGoal", person, goalBf } -> set a body-fat % goal
// POST /api/data { action: "resolveUpload", id }    -> drop a pending upload (after processing)
import { get, put } from '@vercel/blob';

const DATA_PATH = 'tracker/data.json';
const MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_DATA = {
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
      note: 'Baseline, consumer scale (after morning pee) — likely reads off',
    },
  ],
  pendingUploads: [],
};

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

async function readData() {
  let result = null;
  try {
    result = await get(DATA_PATH, { access: 'private' });
  } catch (e) {
    if (e && (e.name === 'BlobNotFoundError' || /not.?found/i.test(String(e.message)))) return null;
    throw e;
  }
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  try { return JSON.parse(text); } catch { return null; }
}

async function writeData(data) {
  const payload = JSON.stringify(data);
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
    const err = new Error('dataset too large');
    err.code = 413;
    throw err;
  }
  await put(DATA_PATH, payload, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    addRandomSuffix: false,
  });
}

// Keep only fields we recognise; coerce numbers; never trust client blindly.
const FIELDS = ['weight', 'bodyFatPct', 'skeletalMuscle', 'bodyFatMass', 'bmi'];
function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const person = raw.person === 'kevin' ? 'kevin' : raw.person === 'daniel' ? 'daniel' : null;
  if (!person) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  if (!date) return null;
  const out = {
    id: String(raw.id || `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    person,
    date,
    source: String(raw.source || 'Manual').slice(0, 24),
    note: String(raw.note || '').slice(0, 240),
  };
  for (const f of FIELDS) {
    const n = Number(raw[f]);
    out[f] = Number.isFinite(n) && raw[f] !== '' && raw[f] !== null ? n : null;
  }
  return out;
}

function sortEntries(data) {
  data.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'GET') {
      const data = (await readData()) || DEFAULT_DATA;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = body && body.action;
      const data = (await readData()) || JSON.parse(JSON.stringify(DEFAULT_DATA));

      if (action === 'addEntry') {
        const entry = cleanEntry(body.entry);
        if (!entry) return res.status(400).json({ error: 'invalid entry' });
        data.entries.push(entry);
        sortEntries(data);
        await writeData(data);
        return res.status(200).json(data);
      }

      if (action === 'updateEntry') {
        const entry = cleanEntry(body.entry);
        if (!entry) return res.status(400).json({ error: 'invalid entry' });
        const i = data.entries.findIndex((e) => e.id === entry.id);
        if (i === -1) return res.status(404).json({ error: 'entry not found' });
        data.entries[i] = entry;
        sortEntries(data);
        await writeData(data);
        return res.status(200).json(data);
      }

      if (action === 'deleteEntry') {
        const id = String(body.id || '');
        data.entries = data.entries.filter((e) => e.id !== id);
        await writeData(data);
        return res.status(200).json(data);
      }

      if (action === 'setGoal') {
        const person = body.person === 'kevin' ? 'kevin' : body.person === 'daniel' ? 'daniel' : null;
        if (!person) return res.status(400).json({ error: 'invalid person' });
        const n = Number(body.goalBf);
        data.people[person].goalBf = Number.isFinite(n) && n > 0 ? n : null;
        await writeData(data);
        return res.status(200).json(data);
      }

      if (action === 'resolveUpload') {
        const id = String(body.id || '');
        data.pendingUploads = (data.pendingUploads || []).filter((u) => u.id !== id);
        await writeData(data);
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    const code = (e && e.code) || 500;
    return res.status(code).json({ error: String((e && e.message) || e) });
  }
}
