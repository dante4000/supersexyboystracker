// Super Sexy Boys body tracker — client. Reads/writes the dataset via /api/data,
// falls back to a localStorage cache and a baked-in seed so it always renders something.

const SEED = {
  version: 1,
  people: {
    daniel: { name: 'Daniel', accent: '#5EC343', goalBf: null },
    kevin: { name: 'Kevin', accent: '#F4801A', goalBf: null },
  },
  entries: [
    { id: 'seed-daniel-1', person: 'daniel', date: '2026-06-02', source: 'InBody', weight: 135.1, bodyFatPct: 11.7, skeletalMuscle: 67.5, bodyFatMass: 15.9, bmi: 20.2, note: 'Baseline InBody scan' },
    { id: 'seed-daniel-2', person: 'daniel', date: '2026-06-03', source: 'InBody', weight: 133.6, bodyFatPct: 10.6, skeletalMuscle: 67.7, bodyFatMass: 14.1, bmi: 19.9, note: 'InBody scan' },
    { id: 'seed-kevin-1', person: 'kevin', date: '2026-05-28', source: 'Scale', weight: 152.7, bodyFatPct: 17.4, skeletalMuscle: null, bodyFatMass: null, bmi: null, note: 'Baseline, consumer scale' },
  ],
  pendingUploads: [],
};

const METRICS = [
  { key: 'bodyFatPct', label: 'Body Fat %', unit: '%', goal: true, lowerBetter: true },
  { key: 'weight', label: 'Weight', unit: 'lb', lowerBetter: true },
  { key: 'skeletalMuscle', label: 'Muscle', unit: 'lb', lowerBetter: false },
  { key: 'bodyFatMass', label: 'Fat mass', unit: 'lb', lowerBetter: true },
  { key: 'bmi', label: 'BMI', unit: '', lowerBetter: true },
];
const CACHE_KEY = 'sbt-data-v1';
const PEOPLE = ['daniel', 'kevin'];

let data = loadCache() || clone(SEED);
let metric = 'bodyFatPct';
let online = false;
const counted = new Set();
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(attrs._ns || 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === '_ns') continue;
    if (k === 'text') n.textContent = v;
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};
const svgEl = (tag, attrs = {}, ...kids) => el(tag, { ...attrs, _ns: 'http://www.w3.org/2000/svg' }, ...kids);

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function loadCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; } }
function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {} }
function fmt(n, d = 1) { return n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d).replace(/\.0$/, ''); }
function entriesFor(p) { return data.entries.filter((e) => e.person === p).sort((a, b) => (a.date < b.date ? -1 : 1)); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function setSync(ok) {
  online = ok;
  $('#syncDot').className = 'dot ' + (ok ? 'ok' : 'off');
  $('#syncText').textContent = ok ? 'synced' : 'offline';
}

async function api(method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api/data', opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

async function load() {
  try {
    const fresh = await api('GET');
    data = fresh; saveCache(); setSync(true);
  } catch {
    setSync(false);
  }
  renderAll();
}

// Persist a mutation: optimistic local render, then POST. On success adopt server truth.
async function mutate(payload) {
  saveCache(); renderAll();
  try {
    const fresh = await api('POST', payload);
    data = fresh; saveCache(); setSync(true); renderAll();
    return true;
  } catch (e) {
    setSync(false); toast('Saved locally — will sync when online');
    return false;
  }
}

/* ---------- Scorecards ---------- */
function renderCards() {
  const root = $('#cards'); root.innerHTML = '';
  for (const p of PEOPLE) {
    const person = data.people[p];
    const list = entriesFor(p);
    const latest = list[list.length - 1];
    const first = list[0];
    const accent = person.accent;

    const card = el('div', { class: 'card', style: `--accent:${accent}` });
    card.append(el('div', { class: 'who' },
      el('span', { class: 'pip' }),
      el('span', { text: person.name }),
      el('span', { class: 'src', text: latest ? `${latest.source} · ${latest.date}` : 'no data' }),
    ));

    const bfVal = latest ? latest.bodyFatPct : null;
    const numEl = el('span', { class: 'num', text: fmt(bfVal) });
    card.append(el('div', { class: 'bf' }, numEl, el('span', { class: 'unit', text: '% body fat' })));
    if (bfVal != null) countUp(numEl, bfVal, p);

    // delta vs baseline
    if (latest && first && first.id !== latest.id && bfVal != null && first.bodyFatPct != null) {
      const d = bfVal - first.bodyFatPct;
      const cls = d < 0 ? 'good' : d > 0 ? 'bad' : 'flat';
      const arrow = d < 0 ? '▼' : d > 0 ? '▲' : '■';
      card.append(el('div', { class: `delta ${cls}`, text: `${arrow} ${Math.abs(d).toFixed(1)}% since baseline` }));
    } else {
      card.append(el('div', { class: 'delta flat', text: 'baseline set' }));
    }

    const mini = el('div', { class: 'mini' });
    const stat = (label, v, u) => el('div', {}, el('span', { text: label }), el('b', { text: v == null ? '—' : `${fmt(v)}${u}` }));
    mini.append(
      stat('Weight', latest && latest.weight, ' lb'),
      stat('Muscle', latest && latest.skeletalMuscle, ' lb'),
      stat('Fat mass', latest && latest.bodyFatMass, ' lb'),
      stat('BMI', latest && latest.bmi, ''),
    );
    card.append(mini);

    // goal bar
    const gb = el('div', { class: 'goalbar' });
    if (person.goalBf && bfVal != null && first && first.bodyFatPct != null) {
      const start = first.bodyFatPct, goal = person.goalBf;
      const prog = Math.max(0, Math.min(1, (start - bfVal) / Math.max(0.1, start - goal)));
      gb.append(el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(prog * 100).toFixed(0)}%` })));
      gb.append(el('div', { class: 'glabel' },
        el('span', { text: `goal ${goal}%` }),
        el('a', { 'data-goal': p, text: bfVal <= goal ? '🎯 hit!' : `${(bfVal - goal).toFixed(1)}% to go` }),
      ));
    } else {
      gb.append(el('div', { class: 'glabel' }, el('span', { text: 'no goal set' }), el('a', { 'data-goal': p, text: '+ set goal' })));
    }
    card.append(gb);
    if (finePointer && !reduceMotion) tiltOnHover(card);
    root.append(card);
  }
  root.querySelectorAll('[data-goal]').forEach((a) => a.addEventListener('click', () => setGoal(a.dataset.goal)));
}

// Animate a number from 0 to target once per page load; afterwards just show the value.
function countUp(node, target, key) {
  if (reduceMotion || counted.has(key)) { node.textContent = fmt(target); return; }
  counted.add(key);
  const dur = 750; let start = null;
  function step(ts) {
    if (start == null) start = ts;
    const k = Math.min(1, (ts - start) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = (target * eased).toFixed(1);
    if (k < 1) requestAnimationFrame(step); else node.textContent = fmt(target);
  }
  requestAnimationFrame(step);
}

// Subtle glassy 3D tilt toward the cursor.
function tiltOnHover(card) {
  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    card.style.transform = `perspective(800px) rotateX(${py * -4}deg) rotateY(${px * 6}deg) translateY(-3px)`;
  });
  card.addEventListener('mouseleave', () => { card.style.transform = ''; });
}

async function setGoal(p) {
  const cur = data.people[p].goalBf;
  const raw = prompt(`${data.people[p].name}'s body-fat % goal:`, cur || '');
  if (raw === null) return;
  const n = Number(raw);
  data.people[p].goalBf = Number.isFinite(n) && n > 0 ? n : null;
  await mutate({ action: 'setGoal', person: p, goalBf: data.people[p].goalBf });
}

/* ---------- Chart ---------- */
function renderChips() {
  const root = $('#metricChips'); root.innerHTML = '';
  for (const m of METRICS) {
    const c = el('button', { class: 'chip', role: 'tab', 'aria-selected': String(m.key === metric), text: m.label });
    c.addEventListener('click', () => { metric = m.key; renderChips(); renderChart(); });
    root.append(c);
  }
}

function renderChart() {
  const root = $('#chart'); root.innerHTML = '';
  const m = METRICS.find((x) => x.key === metric);
  const W = 640, H = 260, padL = 38, padR = 14, padT = 14, padB = 26;

  const series = PEOPLE.map((p) => ({
    p, accent: data.people[p].accent, goal: m.goal ? data.people[p].goalBf : null,
    pts: entriesFor(p).map((e) => ({ t: Date.parse(e.date), v: e[m.key], d: e.date })).filter((d) => d.v != null && Number.isFinite(d.t)),
  }));

  const allV = series.flatMap((s) => s.pts.map((d) => d.v)).concat(series.map((s) => s.goal).filter(Boolean));
  const allT = series.flatMap((s) => s.pts.map((d) => d.t));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${m.label} over time` });

  if (!allV.length) {
    svg.append(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty', text: 'No data for this metric yet' }));
    root.append(svg); renderLegend(series, m); return;
  }

  let minV = Math.min(...allV), maxV = Math.max(...allV);
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const padV = (maxV - minV) * 0.15; minV -= padV; maxV += padV;
  let minT = Math.min(...allT), maxT = Math.max(...allT);
  if (minT === maxT) { minT -= 86400000; maxT += 86400000; }

  const x = (t) => padL + ((t - minT) / (maxT - minT)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - minV) / (maxV - minV)) * (H - padT - padB);

  // y grid + labels
  for (let i = 0; i <= 4; i++) {
    const v = minV + (i / 4) * (maxV - minV);
    const yy = y(v);
    svg.append(svgEl('line', { class: 'grid', x1: padL, y1: yy, x2: W - padR, y2: yy }));
    svg.append(svgEl('text', { class: 'tick', x: padL - 6, y: yy + 3, 'text-anchor': 'end', text: fmt(v, maxV - minV < 5 ? 1 : 0) }));
  }
  // x labels (first + last date)
  for (const t of [minT, maxT]) {
    const dt = new Date(t);
    svg.append(svgEl('text', { class: 'tick', x: x(t), y: H - 8, 'text-anchor': t === minT ? 'start' : 'end',
      text: `${dt.getMonth() + 1}/${dt.getDate()}` }));
  }

  // goal lines
  for (const s of series) {
    if (s.goal != null && s.goal >= minV && s.goal <= maxV) {
      svg.append(svgEl('line', { class: 'goal', x1: padL, y1: y(s.goal), x2: W - padR, y2: y(s.goal), stroke: s.accent }));
    }
  }

  // series lines + points
  for (const s of series) {
    if (!s.pts.length) continue;
    if (s.pts.length > 1) {
      const d = s.pts.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.v).toFixed(1)}`).join(' ');
      svg.append(svgEl('path', { class: 'series', d, stroke: s.accent }));
    }
    for (const pt of s.pts) {
      svg.append(svgEl('circle', {
        class: 'pt', cx: x(pt.t), cy: y(pt.v), r: 4, fill: s.accent,
        'data-name': data.people[s.p].name, 'data-date': pt.d, 'data-val': `${fmt(pt.v)}${m.unit}`,
      }));
    }
  }

  root.append(svg);
  wireTips(svg);
  renderLegend(series, m);
}

let tipEl = null;
function wireTips(svg) {
  if (!tipEl) { tipEl = el('div', { class: 'tip' }); tipEl.hidden = true; document.body.append(tipEl); }
  svg.querySelectorAll('.pt').forEach((c) => {
    c.addEventListener('mouseenter', () => { tipEl.hidden = false; });
    c.addEventListener('mousemove', (e) => {
      tipEl.innerHTML = `${c.getAttribute('data-val')}<small>${c.getAttribute('data-name')} · ${c.getAttribute('data-date')}</small>`;
      tipEl.style.left = `${e.clientX}px`;
      tipEl.style.top = `${e.clientY}px`;
    });
    c.addEventListener('mouseleave', () => { tipEl.hidden = true; });
  });
}

// Gentle mouse parallax on the photographic backdrop, sun flare, and bubbles.
function setupParallax() {
  const photo = document.querySelector('.aero-photo');
  const sun = document.querySelector('.aero-sun');
  const bubbles = document.querySelector('.bubbles');
  if (!photo || reduceMotion || !finePointer) return;
  window.addEventListener('mousemove', (e) => {
    const dx = e.clientX / window.innerWidth - 0.5;
    const dy = e.clientY / window.innerHeight - 0.5;
    photo.style.transform = `scale(1.06) translate(${dx * -14}px, ${dy * -10}px)`;
    if (sun) sun.style.transform = `translate(${dx * 34}px, ${dy * 22}px)`;
    if (bubbles) bubbles.style.transform = `translate(${dx * 10}px, ${dy * 8}px)`;
  }, { passive: true });
}

function renderLegend(series, m) {
  const root = $('#legend'); root.innerHTML = '';
  for (const s of series) {
    root.append(el('span', {}, el('i', { style: `background:${s.accent}` }), document.createTextNode(data.people[s.p].name)));
  }
  if (m.goal && series.some((s) => s.goal != null)) {
    root.append(el('span', { style: 'color:var(--ink-faint)' }, el('i', { class: 'goal' }), document.createTextNode('goal')));
  }
}

/* ---------- Body composition (lean vs fat) ---------- */
// Fat mass: use the logged value, else derive from weight × body-fat %. Lean = weight − fat.
function compFor(p) {
  const latest = entriesFor(p).slice(-1)[0];
  if (!latest || latest.weight == null) return null;
  let fat = latest.bodyFatMass;
  let derived = false;
  if (fat == null && latest.bodyFatPct != null) { fat = latest.weight * latest.bodyFatPct / 100; derived = true; }
  if (fat == null) return null;
  const lean = Math.max(0, latest.weight - fat);
  return { weight: latest.weight, fat, lean, derived, pct: latest.bodyFatPct };
}

function renderComposition() {
  const root = $('#composition'); root.innerHTML = '';
  const rows = PEOPLE.map((p) => ({ p, c: compFor(p) })).filter((r) => r.c);
  if (!rows.length) { root.append(el('div', { class: 'comp-note', text: 'Log a weight to see composition.' })); return; }
  const maxW = Math.max(...rows.map((r) => r.c.weight));
  for (const { p, c } of rows) {
    const accent = data.people[p].accent;
    const scale = c.weight / maxW; // bar length proportional to bodyweight
    const leanPct = (c.lean / c.weight) * 100, fatPct = (c.fat / c.weight) * 100;
    const row = el('div', { class: 'comp-row' });
    row.append(el('div', { class: 'comp-top' },
      el('span', { class: 'comp-name' }, el('span', { class: 'pip', style: `--p:${accent}` }), document.createTextNode(data.people[p].name)),
      el('span', { class: 'comp-tot', text: `${fmt(c.weight)} lb` }),
    ));
    const bar = el('div', { class: 'comp-bar', style: `width:${(scale * 100).toFixed(1)}%` });
    bar.append(el('div', { class: 'seg lean', style: `flex:${c.lean};background-color:${accent}`, text: `lean ${fmt(c.lean)}` }));
    bar.append(el('div', { class: 'seg fat', style: `flex:${c.fat}`, text: `fat ${fmt(c.fat)}` }));
    row.append(bar);
    row.append(el('div', { class: 'comp-note', text: `${fmt(leanPct)}% lean · ${fmt(fatPct)}% fat${c.derived ? ' (fat est. from %)' : ''}` }));
    root.append(row);
  }
}

/* ---------- Goal gauges ---------- */
function renderGauges() {
  const root = $('#gauges'); root.innerHTML = '';
  for (const p of PEOPLE) {
    const person = data.people[p];
    const list = entriesFor(p);
    const now = list.slice(-1)[0] && list.slice(-1)[0].bodyFatPct;
    const accent = person.accent;
    const g = el('div', { class: 'gauge', style: `--accent:${accent}` });

    if (now == null) { root.append(g); continue; }

    if (!person.goalBf) {
      g.append(el('div', { class: 'g-top' },
        el('b', { text: person.name }),
        el('span', { class: 'g-now', text: `${fmt(now)}% now` }),
      ));
      g.append(el('div', { class: 'g-empty' }, el('a', { 'data-goal': p, text: '+ set a goal to track progress' })));
      root.append(g);
      continue;
    }

    const start = list[0].bodyFatPct ?? now;
    const goal = person.goalBf;
    // Scale: from start (or now if higher) down to a hair past the goal.
    const top = Math.max(start, now);
    const bottom = Math.min(goal, now) - 1;
    const span = Math.max(0.1, top - bottom);
    const nowX = ((top - now) / span) * 100;       // further right = lower bf = better
    const goalX = ((top - goal) / span) * 100;
    const done = now <= goal;

    g.append(el('div', { class: 'g-top' },
      el('b', { text: person.name }),
      el('span', { class: 'g-now', text: done ? `🎯 ${fmt(now)}% — goal hit!` : `${fmt(now)}% → ${goal}% (${fmt(now - goal)} to go)` }),
    ));
    const track = el('div', { class: 'g-track' },
      el('div', { class: 'g-fill', style: `width:${Math.max(0, Math.min(100, nowX)).toFixed(1)}%` }),
      el('div', { class: 'g-goal', style: `left:${Math.max(0, Math.min(100, goalX)).toFixed(1)}%` }),
    );
    g.append(track);
    g.append(el('div', { class: 'g-scale' },
      el('span', { text: `${fmt(top)}%` }),
      el('a', { 'data-goal': p, style: 'color:var(--ink-faint);cursor:pointer', text: 'edit goal' }),
    ));
    root.append(g);
  }
  root.querySelectorAll('[data-goal]').forEach((a) => a.addEventListener('click', () => setGoal(a.dataset.goal)));
}

/* ---------- Pending uploads ---------- */
function renderPending() {
  const root = $('#pending');
  const list = data.pendingUploads || [];
  if (!list.length) { root.hidden = true; root.innerHTML = ''; return; }
  root.hidden = false; root.innerHTML = '';
  const byPerson = list.reduce((a, u) => ((a[u.person] = (a[u.person] || 0) + 1), a), {});
  const parts = Object.entries(byPerson).map(([p, n]) => `${data.people[p].name} ×${n}`).join(', ');
  root.append(
    el('span', { text: '📥' }),
    el('span', {}, document.createTextNode('Screenshots waiting to be read: '), el('b', { text: parts })),
    el('span', { style: 'color:var(--ink-faint);font-size:12px', text: '— tell Claude "process the uploads" and the numbers get added.' }),
  );
}

/* ---------- History ---------- */
function renderHistory() {
  const tb = $('#history tbody'); tb.innerHTML = '';
  const rows = [...data.entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const e of rows) {
    const tr = el('tr', {},
      el('td', { text: e.date }),
      el('td', {}, el('span', { class: 'who-pip', style: `background:${data.people[e.person].accent}` }), document.createTextNode(data.people[e.person].name)),
      el('td', {}, el('b', { text: fmt(e.bodyFatPct) })),
      el('td', { text: fmt(e.weight) }),
      el('td', { text: fmt(e.skeletalMuscle) }),
      el('td', { text: fmt(e.bodyFatMass) }),
      el('td', { text: fmt(e.bmi) }),
      el('td', { text: e.source }),
    );
    const del = el('button', { class: 'del', title: 'delete', text: '✕' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ${data.people[e.person].name}'s ${e.date} entry?`)) return;
      data.entries = data.entries.filter((x) => x.id !== e.id);
      await mutate({ action: 'deleteEntry', id: e.id });
    });
    tr.append(el('td', {}, del));
    tb.append(tr);
  }
}

function renderAll() { renderCards(); renderChips(); renderChart(); renderComposition(); renderGauges(); renderPending(); renderHistory(); }

/* ---------- Form + upload ---------- */
function todayISO() {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function wireForm() {
  const form = $('#entryForm');
  const toggle = $('#toggleForm');
  toggle.addEventListener('click', () => {
    const show = form.hidden;
    form.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    toggle.textContent = show ? '− Close' : '+ Add';
    if (show && !form.date.value) form.date.value = todayISO();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const entry = {
      person: fd.get('person'),
      date: fd.get('date'),
      source: fd.get('source') || 'Manual',
      note: fd.get('note') || '',
    };
    let any = false;
    for (const k of ['bodyFatPct', 'weight', 'skeletalMuscle', 'bodyFatMass', 'bmi']) {
      const v = fd.get(k);
      entry[k] = v === '' || v == null ? null : Number(v);
      if (entry[k] != null) any = true;
    }
    if (!any) { toast('Enter at least one number'); return; }
    entry.id = `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    data.entries.push(entry);
    data.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
    const ok = await mutate({ action: 'addEntry', entry });
    toast(ok ? 'Saved ✓' : 'Saved locally');
    form.reset();
  });

  $('#shotInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const person = $('#entryForm').person.value;
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    toast('Uploading screenshot…');
    try {
      const r = await fetch(`/api/upload?person=${person}&ext=${encodeURIComponent(ext)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'upload failed');
      toast('Screenshot saved — I\'ll read it later 📸');
      await load();
    } catch (e) {
      toast('Upload failed: ' + e.message);
    } finally {
      ev.target.value = '';
    }
  });
}

wireForm();
setupParallax();
renderAll();
load();
