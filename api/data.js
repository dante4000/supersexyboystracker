// Body recomposition dataset, stored as a single private Vercel Blob (tracker/data.json).
//
// GET  /api/data                                  -> full dataset (seeded if none yet)
// POST /api/data { action: "addEntry", entry }   -> append a measurement
// POST /api/data { action: "updateEntry", entry } -> replace by id
// POST /api/data { action: "deleteEntry", id }   -> remove by id
// POST /api/data { action: "setGoal", person, goalBf } -> set a body-fat % goal
// POST /api/data { action: "resolveUpload", id } -> drop a pending upload
import {
  cleanEntry,
  cleanGoal,
  errorStatus,
  loadData,
  readJsonBody,
  sortEntries,
  writeData,
} from './dataset.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'GET') {
      const data = await loadData({ seed: true });
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = body && body.action;
      const data = await loadData({ seed: false });

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
        const before = data.entries.length;
        data.entries = data.entries.filter((e) => e.id !== id);
        if (data.entries.length === before) return res.status(404).json({ error: 'entry not found' });
        await writeData(data);
        return res.status(200).json(data);
      }

      if (action === 'setGoal') {
        const person = body.person === 'kevin' ? 'kevin' : body.person === 'daniel' ? 'daniel' : null;
        if (!person) return res.status(400).json({ error: 'invalid person' });
        const goal = cleanGoal(body.goalBf);
        if (!goal.ok) return res.status(400).json({ error: 'invalid goal' });
        data.people[person].goalBf = goal.value;
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
    return res.status(errorStatus(e)).json({ error: String((e && e.message) || e) });
  }
}
