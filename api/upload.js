// Screenshot intake. The dashboard POSTs the raw image bytes here; we stash them in a
// private Vercel Blob and record a "pending upload" in the dataset so the numbers can be
// transcribed later (by a human or by Claude via `npm run pull-uploads`).
//
// POST /api/upload?person=daniel&ext=png   (body = raw image bytes)
//   -> { ok: true, upload: { id, person, blobPath, uploadedAt } }
import { get, put } from '@vercel/blob';

const DATA_PATH = 'tracker/data.json';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const OK_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif']);

async function readRaw(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_IMAGE_BYTES) throw Object.assign(new Error('image too large'), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readData() {
  try {
    const result = await get(DATA_PATH, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    if (e && (e.name === 'BlobNotFoundError' || /not.?found/i.test(String(e.message)))) return null;
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const q = req.query || {};
    const person = q.person === 'kevin' ? 'kevin' : q.person === 'daniel' ? 'daniel' : null;
    if (!person) return res.status(400).json({ error: 'missing or invalid person' });

    let ext = String(q.ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!OK_EXT.has(ext)) ext = 'png';

    const bytes = await readRaw(req);
    if (!bytes.length) return res.status(400).json({ error: 'empty body' });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blobPath = `tracker/uploads/${person}/${stamp}.${ext}`;
    await put(blobPath, bytes, {
      access: 'private',
      allowOverwrite: false,
      addRandomSuffix: true,
      contentType: req.headers['content-type'] || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    });

    const upload = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      person,
      blobPath,
      uploadedAt: new Date().toISOString(),
      bytes: bytes.length,
    };

    // Record it as pending. Best-effort: if the dataset write races, the blob still exists.
    const data = (await readData()) || null;
    if (data) {
      data.pendingUploads = data.pendingUploads || [];
      data.pendingUploads.push(upload);
      await put(DATA_PATH, JSON.stringify(data), {
        access: 'private',
        allowOverwrite: true,
        contentType: 'application/json',
        addRandomSuffix: false,
      });
    }

    return res.status(200).json({ ok: true, upload });
  } catch (e) {
    const code = (e && e.code) || 500;
    return res.status(code).json({ error: String((e && e.message) || e) });
  }
}
