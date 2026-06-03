// Download every pending screenshot from the private Blob store to ./data/uploads/ so the
// numbers can be transcribed (by a human, or by Claude reading the image files).
//
//   npm run pull-uploads
//
// Reads BLOB_READ_WRITE_TOKEN from .env.local (or the environment).
import { get } from '@vercel/blob';
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
  const r = await get(path, { access: 'private' });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return JSON.parse(await new Response(r.stream).text());
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
      const r = await get(u.blobPath, { access: 'private' });
      const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
      const local = join(OUT_DIR, `${u.person}__${basename(u.blobPath)}`);
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
