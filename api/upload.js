// Screenshot intake. The dashboard POSTs the raw image bytes here; we stash them in a
// private Vercel Blob and record a "pending upload" in the dataset so the numbers can be
// transcribed later (by a human or by Claude via `npm run pull-uploads`).
//
// POST /api/upload?person=daniel&ext=png   (body = raw image bytes)
//   -> { ok: true, upload: { id, person, blobPath, uploadedAt } }
import { put } from '@vercel/blob';
import { errorStatus, loadData, writeData } from './dataset.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const OK_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif']);

async function readRaw(req) {
  // Vercel's runtime buffers and consumes the request stream before the handler
  // runs, exposing the bytes on req.body (a Buffer for binary content types).
  // Iterating `req` here would yield nothing, so read req.body first and only
  // fall back to streaming for runtimes that leave the stream intact.
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (typeof b === 'string') return Buffer.from(b, 'binary');
  if (b && typeof b === 'object' && b.type === 'Buffer' && Array.isArray(b.data)) return Buffer.from(b.data);
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_IMAGE_BYTES) throw Object.assign(new Error('image too large'), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
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
    if (bytes.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image too large' });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blobPath = `tracker/uploads/${person}/${stamp}.${ext}`;
    // Derive the stored content type from the extension — the request arrives as
    // application/octet-stream so the runtime preserves the raw bytes.
    const blob = await put(blobPath, bytes, {
      access: 'private',
      allowOverwrite: false,
      addRandomSuffix: true,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    });

    const upload = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      person,
      blobPath: blob.pathname,
      url: blob.url,
      contentType: blob.contentType,
      uploadedAt: new Date().toISOString(),
      bytes: bytes.length,
    };

    const data = await loadData({ seed: false });
    data.pendingUploads = data.pendingUploads || [];
    data.pendingUploads.push(upload);
    await writeData(data);

    return res.status(200).json({ ok: true, upload });
  } catch (e) {
    return res.status(errorStatus(e)).json({ error: String((e && e.message) || e) });
  }
}
