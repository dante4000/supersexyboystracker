// Local preview server: serves the static site and answers /api/data with the live
// dataset so the dashboard renders with real data — without needing `vercel dev`.
//   node tools/preview.mjs            # serves on http://localhost:4555
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PREVIEW_PORT || 4555);

async function loadEnv() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const txt = await readFile(join(ROOT, '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* rely on env */ }
}

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml',
};

await loadEnv();
const { loadData } = await import('../api/dataset.js');

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/data') {
    const data = await loadData({ seed: true });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(data));
  }
  const file = url === '/' ? '/index.html' : url;
  try {
    const body = await readFile(join(ROOT, file));
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`preview on http://localhost:${PORT}`));
