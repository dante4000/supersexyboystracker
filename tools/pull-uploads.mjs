// Download every pending screenshot from the private Blob store to ./data/uploads/ so the
// numbers can be transcribed (by a human, or by Claude reading the image files).
//
//   npm run pull-uploads
//
// Reads BLOB_READ_WRITE_TOKEN from .env.local (or the environment).
import { get, list } from '@vercel/blob';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'data', 'uploads');
const DATA_PATH = 'tracker/data.json';

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

async function getJson(path) {
  const r = await get(path, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return JSON.parse(await new Response(r.stream).text());
}

async function getBlob(pathOrUrl) {
  const r = await get(pathOrUrl, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return r;
}

async function findLegacyBlobPath(upload) {
  const stored = String(upload.blobPath || '').trim();
  if (!stored) return null;
  const dot = stored.lastIndexOf('.');
  const prefix = dot > 0 ? stored.slice(0, dot) : stored;
  const result = await list({ prefix, limit: 10 });
  if (!result.blobs.length) return null;
  const exact = result.blobs.find((b) => b.pathname === stored);
  return (exact || result.blobs[0]).pathname;
}

async function readUploadBlob(upload) {
  for (const candidate of [upload.blobPath, upload.pathname, upload.url].filter(Boolean)) {
    const blob = await getBlob(candidate).catch(() => null);
    if (blob) return { blob, path: candidate };
  }

  const legacyPath = await findLegacyBlobPath(upload).catch(() => null);
  if (!legacyPath) return null;
  const blob = await getBlob(legacyPath).catch(() => null);
  return blob ? { blob, path: legacyPath } : null;
}

async function main() {
  await loadEnv();
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Missing BLOB_READ_WRITE_TOKEN (set it in .env.local or the environment).');
    process.exit(1);
  }

  const data = await getJson(DATA_PATH);
  const pending = (data && data.pendingUploads) || [];
  if (!pending.length) {
    console.log('No pending uploads. ✨');
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`${pending.length} pending upload(s):\n`);

  for (const u of pending) {
    try {
      const found = await readUploadBlob(u);
      if (!found) throw new Error('blob not found');
      const buf = Buffer.from(await new Response(found.blob.stream).arrayBuffer());
      const pathname = (found.blob.blob && found.blob.blob.pathname) || found.path;
      const local = join(OUT_DIR, `${u.person}__${basename(pathname)}`);
      await writeFile(local, buf);
      console.log(`  ${u.person.padEnd(7)} ${u.uploadedAt}  ->  ${local}  (id: ${u.id})`);
    } catch (e) {
      console.error(`  ! failed ${u.blobPath}: ${e.message}`);
    }
  }

  console.log(
    `\nDownloaded to ${OUT_DIR}.\n` +
    'After transcribing, POST {action:"resolveUpload", id} to /api/data to clear each one.',
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
