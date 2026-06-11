// Super Sexy Boys body tracker — client. Reads/writes the dataset via /api/data.
// A baked-in seed provides the first paint until the GET resolves.

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
const FIELD_RULES = {
  bodyFatPct: { label: 'Body Fat %', min: 0, max: 75 },
  weight: { label: 'Weight', min: 1, max: 1000 },
  skeletalMuscle: { label: 'Muscle', min: 0, max: 500 },
  bodyFatMass: { label: 'Fat mass', min: 0, max: 500 },
  bmi: { label: 'BMI', min: 5, max: 100 },
};
const PEOPLE = ['daniel', 'kevin'];

let data = clone(SEED);
let metric = 'bodyFatPct';
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
function fmt(n, d = 1) { return n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d).replace(/\.0$/, ''); }
function compareEntries(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.person !== b.person) return a.person < b.person ? -1 : 1;
  return String(a.id || '').localeCompare(String(b.id || ''));
}
function metricValue(entry, key) {
  const value = entry && Number(entry[key]);
  return entry && entry[key] != null && Number.isFinite(value) ? value : null;
}
function entriesFor(p) { return data.entries.filter((e) => e.person === p).sort(compareEntries); }
function entriesWith(p, key) { return entriesFor(p).filter((e) => metricValue(e, key) != null); }
function latestEntry(p, key = null) {
  const list = key ? entriesWith(p, key) : entriesFor(p);
  return list[list.length - 1] || null;
}
function firstEntry(p, key = null) {
  const list = key ? entriesWith(p, key) : entriesFor(p);
  return list[0] || null;
}
function latestValue(p, key) {
  const entry = latestEntry(p, key);
  return metricValue(entry, key);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
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
    data = await api('GET');
  } catch {
    toast('Couldn’t reach the server');
  }
  renderAll();
}

// Persist a mutation: render the caller's optimistic change, POST, adopt server
// truth. If the POST fails, reload from the server so we never show a phantom save.
async function mutate(payload) {
  renderAll();
  try {
    data = await api('POST', payload);
    renderAll();
    return true;
  } catch {
    toast('Save failed — check your connection');
    await load();
    return false;
  }
}

/* ---------- Scorecards ---------- */
function renderCards() {
  const root = $('#cards'); root.innerHTML = '';
  for (const p of PEOPLE) {
    const person = data.people[p];
    const latest = latestEntry(p);
    const latestBf = latestEntry(p, 'bodyFatPct');
    const firstBf = firstEntry(p, 'bodyFatPct');
    const accent = person.accent;

    const card = el('div', { class: 'card', style: `--accent:${accent}` });
    card.append(el('div', { class: 'who' },
      el('span', { class: 'pip' }),
      el('span', { text: person.name }),
      el('span', { class: 'src', text: latest ? `${latest.source} · ${latest.date}` : 'no data' }),
    ));

    const bfVal = metricValue(latestBf, 'bodyFatPct');
    const numEl = el('span', { class: 'num', text: fmt(bfVal) });
    card.append(el('div', { class: 'bf' }, numEl, el('span', { class: 'unit', text: '% body fat' })));
    if (bfVal != null) countUp(numEl, bfVal, p);

    // delta vs baseline
    if (latestBf && firstBf && firstBf.id !== latestBf.id) {
      const d = bfVal - metricValue(firstBf, 'bodyFatPct');
      const cls = d < 0 ? 'good' : d > 0 ? 'bad' : 'flat';
      const arrow = d < 0 ? '▼' : d > 0 ? '▲' : '■';
      card.append(el('div', { class: `delta ${cls}`, text: `${arrow} ${Math.abs(d).toFixed(1)}% since baseline` }));
    } else {
      card.append(el('div', { class: 'delta flat', text: 'baseline set' }));
    }

    const mini = el('div', { class: 'mini' });
    const stat = (label, v, u) => el('div', {}, el('span', { text: label }), el('b', { text: v == null ? '—' : `${fmt(v)}${u}` }));
    mini.append(
      stat('Weight', latestValue(p, 'weight'), ' lb'),
      stat('Muscle', latestValue(p, 'skeletalMuscle'), ' lb'),
      stat('Fat mass', latestValue(p, 'bodyFatMass'), ' lb'),
      stat('BMI', latestValue(p, 'bmi'), ''),
    );
    card.append(mini);

    // goal bar
    const gb = el('div', { class: 'goalbar' });
    if (person.goalBf != null && bfVal != null && firstBf) {
      const start = metricValue(firstBf, 'bodyFatPct'), goal = person.goalBf;
      const prog = Math.max(0, Math.min(1, (start - bfVal) / Math.max(0.1, start - goal)));
      gb.append(el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(prog * 100).toFixed(0)}%` })));
      gb.append(el('div', { class: 'glabel' },
        el('span', { text: `goal ${goal}%` }),
        el('a', { 'data-goal': p, text: bfVal <= goal ? '🎯 hit!' : `${(bfVal - goal).toFixed(1)}% to go` }),
      ));
    } else if (person.goalBf != null) {
      gb.append(el('div', { class: 'glabel' }, el('span', { text: `goal ${person.goalBf}%` }), el('a', { 'data-goal': p, text: 'edit goal' })));
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
  const text = String(raw).trim();
  const n = text === '' ? null : Number(text);
  if (n != null && (!Number.isFinite(n) || n <= 0 || n > 75)) {
    toast('Enter a goal between 0 and 75%');
    return;
  }
  data.people[p].goalBf = n;
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
  const W = 640, H = 260, padL = 46, padR = 14, padT = 14, padB = 26;

  const series = PEOPLE.map((p) => ({
    p, accent: data.people[p].accent, goal: m.goal ? data.people[p].goalBf : null,
    pts: entriesFor(p)
      .map((e) => ({ t: Date.parse(e.date), v: metricValue(e, m.key), d: e.date }))
      .filter((d) => d.v != null && Number.isFinite(d.t)),
  }));

  const allV = series.flatMap((s) => s.pts.map((d) => d.v)).concat(series.map((s) => s.goal).filter((v) => v != null));
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
  // x labels (first + last date). Dates parse as UTC midnight, so read them back
  // in UTC — local getters would show the previous day west of Greenwich.
  for (const t of [minT, maxT]) {
    const dt = new Date(t);
    svg.append(svgEl('text', { class: 'tick', x: x(t), y: H - 8, 'text-anchor': t === minT ? 'start' : 'end',
      text: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }));
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
  const latest = [...entriesFor(p)].reverse().find((e) => (
    metricValue(e, 'weight') != null &&
    (metricValue(e, 'bodyFatMass') != null || metricValue(e, 'bodyFatPct') != null)
  ));
  if (!latest) return null;
  const weight = metricValue(latest, 'weight');
  let fat = metricValue(latest, 'bodyFatMass');
  let derived = false;
  const bodyFatPct = metricValue(latest, 'bodyFatPct');
  if (fat == null && bodyFatPct != null) { fat = weight * bodyFatPct / 100; derived = true; }
  if (fat == null) return null;
  const lean = Math.max(0, weight - fat);
  return { weight, fat, lean, derived, pct: bodyFatPct };
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
    const list = entriesWith(p, 'bodyFatPct');
    const latestBf = list[list.length - 1];
    const now = metricValue(latestBf, 'bodyFatPct');
    const accent = person.accent;
    const g = el('div', { class: 'gauge', style: `--accent:${accent}` });

    if (now == null) {
      g.append(el('div', { class: 'g-top' },
        el('b', { text: person.name }),
        el('span', { class: 'g-now', text: 'no body-fat data' }),
      ));
      g.append(el('div', { class: 'g-empty' }, el('a', { 'data-goal': p, text: person.goalBf == null ? '+ set a goal' : 'edit goal' })));
      root.append(g);
      continue;
    }

    if (person.goalBf == null) {
      g.append(el('div', { class: 'g-top' },
        el('b', { text: person.name }),
        el('span', { class: 'g-now', text: `${fmt(now)}% now` }),
      ));
      g.append(el('div', { class: 'g-empty' }, el('a', { 'data-goal': p, text: '+ set a goal to track progress' })));
      root.append(g);
      continue;
    }

    const start = metricValue(list[0], 'bodyFatPct') ?? now;
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
  const rows = [...data.entries].sort((a, b) => compareEntries(b, a)); // newest first, stable ties
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
    const edit = el('button', { class: 'edit', type: 'button', title: 'edit entry', text: 'Edit' });
    edit.addEventListener('click', () => startEdit(e.id));
    const del = el('button', { class: 'del', type: 'button', title: 'delete', text: '✕' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ${data.people[e.person].name}'s ${e.date} entry?`)) return;
      data.entries = data.entries.filter((x) => x.id !== e.id);
      await mutate({ action: 'deleteEntry', id: e.id });
    });
    tr.append(el('td', {}, el('div', { class: 'row-actions' }, edit, del)));
    tb.append(tr);
  }
}

function renderAll() { renderCards(); renderChips(); renderChart(); renderComposition(); renderGauges(); renderPending(); renderHistory(); }

/* ---------- Form + upload ---------- */
let editingId = null;

function todayISO() {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function control(form, name) { return form.elements.namedItem(name); }

function setFormOpen(show) {
  const form = $('#entryForm');
  const toggle = $('#toggleForm');
  const submit = form.querySelector('button[type="submit"]');
  form.hidden = !show;
  toggle.setAttribute('aria-expanded', String(show));
  toggle.textContent = show ? '− Close' : '+ Add';
  if (show && !control(form, 'date').value) control(form, 'date').value = todayISO();
  if (!show) {
    editingId = null;
    submit.textContent = 'Save entry';
    form.reset();
  }
}

function fillForm(entry) {
  const form = $('#entryForm');
  const submit = form.querySelector('button[type="submit"]');
  setFormOpen(true);
  editingId = entry.id;
  submit.textContent = 'Update entry';
  for (const name of ['person', 'date', 'source', 'note', 'bodyFatPct', 'weight', 'skeletalMuscle', 'bodyFatMass', 'bmi']) {
    control(form, name).value = entry[name] == null ? '' : String(entry[name]);
  }
  form.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
}

function startEdit(id) {
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) { toast('Entry not found'); return; }
  fillForm(entry);
}

function readEntryFromForm(form) {
  const fd = new FormData(form);
  const entry = {
    person: fd.get('person'),
    date: fd.get('date'),
    source: String(fd.get('source') || '').trim() || 'Manual',
    note: String(fd.get('note') || '').trim(),
  };

  let any = false;
  for (const k of Object.keys(FIELD_RULES)) {
    const raw = String(fd.get(k) || '').trim();
    if (raw === '') {
      entry[k] = null;
      continue;
    }
    const n = Number(raw);
    const rule = FIELD_RULES[k];
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
      toast(`${rule.label} looks invalid`);
      return null;
    }
    entry[k] = n;
    any = true;
  }
  if (!any) { toast('Enter at least one number'); return null; }
  return entry;
}

function wireForm() {
  const form = $('#entryForm');
  const toggle = $('#toggleForm');
  toggle.addEventListener('click', () => {
    setFormOpen(form.hidden);
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const entry = readEntryFromForm(form);
    if (!entry) return;

    const wasEditing = editingId != null;
    if (wasEditing) {
      entry.id = editingId;
      const i = data.entries.findIndex((e) => e.id === editingId);
      if (i === -1) { toast('Entry not found'); return; }
      data.entries[i] = entry;
    } else {
      entry.id = `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      data.entries.push(entry);
    }
    data.entries.sort(compareEntries);
    const ok = await mutate({ action: wasEditing ? 'updateEntry' : 'addEntry', entry });
    if (!ok) return;
    toast(wasEditing ? 'Updated ✓' : 'Saved ✓');
    form.reset();
    control(form, 'date').value = todayISO();
    editingId = null;
    form.querySelector('button[type="submit"]').textContent = 'Save entry';
  });

  $('#shotInput').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    const person = control(form, 'person').value;
    let saved = 0;
    const failed = [];
    // Upload one at a time: each upload read-modify-writes the shared dataset
    // blob server-side, so parallel POSTs would drop each other's entries.
    for (const [i, file] of files.entries()) {
      const label = files.length > 1 ? ` ${i + 1}/${files.length}` : '';
      if (file.size > 12 * 1024 * 1024) {
        failed.push(`${file.name} is too large`);
        continue;
      }
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      toast(`Uploading screenshot${label}…`);
      try {
        // Send as octet-stream: with an image/* content type the serverless runtime
        // drops the body, so the upload would arrive empty. The real image type is
        // recorded server-side from the `ext` query param.
        const r = await fetch(`/api/upload?person=${person}&ext=${encodeURIComponent(ext)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'upload failed');
        saved++;
      } catch (e) {
        failed.push(`${file.name}: ${e.message}`);
      }
    }
    ev.target.value = '';
    if (failed.length) {
      toast(`${saved ? `Saved ${saved}, ` : ''}failed ${failed.length}: ${failed[0]}`);
    } else {
      toast(saved > 1 ? `${saved} screenshots saved — I'll read them later 📸` : 'Screenshot saved — I\'ll read it later 📸');
    }
    if (saved) await load();
  });
}

wireForm();
setupParallax();
renderAll();
load();
