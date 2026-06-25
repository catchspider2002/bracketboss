// BracketBoss frontend — one script for all three pages.
const ROUND_ORDER = ['r32', 'r16', 'qf', 'sf', 'final', 'third'];
const ROUND_LABEL = {
  r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-finals',
  sf: 'Semi-finals', final: 'Final', third: 'Third-place play-off',
};

function feedersOf(slotId) {
  const [round, i] = slotId.split('_'); const n = Number(i);
  switch (round) {
    case 'r16': return [`r32_${2 * n}`, `r32_${2 * n + 1}`];
    case 'qf': return [`r16_${2 * n}`, `r16_${2 * n + 1}`];
    case 'sf': return [`qf_${2 * n}`, `qf_${2 * n + 1}`];
    case 'final': return ['sf_0', 'sf_1'];
    case 'third': return ['sf_0', 'sf_1'];
    default: return [];
  }
}
const qs = (s, r = document) => r.querySelector(s);
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
});
const param = (k) => new URLSearchParams(location.search).get(k);

const page = document.body.dataset.page;
if (page === 'home') initHome();
if (page === 'bracket') initBracket();
if (page === 'leaderboard') initLeaderboard();

// ---------- Home ----------
function initHome() {
  qs('#create-btn').addEventListener('click', async () => {
    const out = qs('#create-out');
    try {
      const { code } = await api('/api/group', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: qs('#group-name').value || null }),
      });
      out.innerHTML = `Group code: <b class="mono">${code}</b> — <a href="/bracket.html?group=${code}">build your bracket →</a><br>Share this code with friends.`;
    } catch (e) { out.textContent = e.message; }
  });
  qs('#join-btn').addEventListener('click', () => {
    const code = (qs('#join-code').value || '').trim().toUpperCase();
    if (code.length !== 6) { qs('#join-out').textContent = 'Enter a 6-character code.'; return; }
    location.href = `/bracket.html?group=${code}`;
  });
}

// ---------- Bracket (builder + read-only view) ----------
function initBracket() {
  const id = param('id');
  if (id) return renderView(id);
  const group = param('group');
  if (!group) { qs('#bracket').innerHTML = '<p class="muted">No group specified. <a href="/">Go home</a>.</p>'; return; }
  buildMode(group);
}

async function buildMode(group) {
  const data = await api('/api/matches/knockout');
  const seeds = {}; // slotId -> {home, away} for r32
  data.nodes.forEach((n) => { if (n.round === 'r32') seeds[n.slotId] = { home: n.home, away: n.away }; });

  if (data.locked) {
    qs('#status-bar').innerHTML = `Brackets are <b>locked</b> — the knockout stage has started. <a href="/leaderboard.html?group=${group}">View leaderboard →</a>`;
    qs('#bracket').innerHTML = '<p class="muted">Submissions are closed for this tournament.</p>';
    return;
  }
  qs('#status-bar').innerHTML = `Group <b class="mono">${group}</b> — pick a winner in every match.`;
  qs('#builder-actions').classList.remove('hidden');

  const picks = {};
  const participants = (slotId) => {
    if (seeds[slotId]) return [seeds[slotId].home, seeds[slotId].away];
    const f = feedersOf(slotId);
    if (slotId.startsWith('third')) {
      return f.map((s) => { const p = participants(s); return p.find((t) => t && t !== picks[s]) || null; });
    }
    return f.map((s) => picks[s] || null);
  };
  const prune = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of ROUND_ORDER) {
        if (r === 'r32') continue;
        for (let i = 0; i < sizeOf(r); i++) {
          const s = `${r}_${i}`;
          if (picks[s] && !participants(s).includes(picks[s])) { delete picks[s]; changed = true; }
        }
      }
    }
  };
  const onPick = (slotId, team) => { if (!team) return; picks[slotId] = team; prune(); render(); };

  function render() {
    const root = qs('#bracket'); root.innerHTML = '';
    for (const round of ROUND_ORDER) {
      const sec = document.createElement('div'); sec.className = `round ${round}`;
      sec.innerHTML = `<h3>${ROUND_LABEL[round]}</h3>`;
      const grid = document.createElement('div'); grid.className = 'round-matches';
      for (let i = 0; i < sizeOf(round); i++) {
        const slotId = `${round}_${i}`;
        const [home, away] = participants(slotId);
        grid.appendChild(matchEl(slotId, home, away, picks[slotId], onPick));
      }
      sec.appendChild(grid); root.appendChild(sec);
    }
    const count = Object.keys(picks).length;
    qs('#pick-count').textContent = String(count);
    qs('#submit-btn').disabled = count !== 32;
  }

  qs('#submit-btn').addEventListener('click', async () => {
    const userName = (qs('#user-name').value || '').trim();
    if (!userName) { qs('#submit-out').textContent = 'Enter your name first.'; return; }
    try {
      const { bracketId, shareUrl } = await api('/api/bracket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupCode: group, userName, picks }),
      });
      qs('#builder-actions').classList.add('hidden');
      qs('#submit-out').innerHTML = `Submitted! Share link: <a href="${shareUrl}">${shareUrl}</a>`;
      const post = qs('#post-actions'); post.classList.remove('hidden');
      qs('#leaderboard-link').href = `/leaderboard.html?group=${group}`;
      qs('#share-btn').addEventListener('click', () => navigator.clipboard.writeText(shareUrl));
    } catch (e) { qs('#submit-out').textContent = e.message; }
  });

  render();
}

async function renderView(id) {
  let data;
  try { data = await api(`/api/bracket/${id}`); }
  catch (e) { qs('#bracket').innerHTML = `<p class="muted">${e.message}</p>`; return; }

  qs('#status-bar').innerHTML = `<b>${escapeHtml(data.userName)}</b>'s bracket — group <span class="mono">${data.groupCode}</span>`;
  const pill = qs('#score-pill'); pill.classList.remove('hidden');
  pill.textContent = `${data.score.total} pts · ${data.score.correctPicks} correct`;

  const root = qs('#bracket'); root.innerHTML = '';
  for (const round of ROUND_ORDER) {
    const sec = document.createElement('div'); sec.className = `round ${round}`;
    sec.innerHTML = `<h3>${ROUND_LABEL[round]}</h3>`;
    const grid = document.createElement('div'); grid.className = 'round-matches';
    for (let i = 0; i < sizeOf(round); i++) {
      const slotId = `${round}_${i}`;
      const pick = data.picks[slotId];
      const res = data.results[slotId] || {};
      const el = document.createElement('div'); el.className = 'match';
      let cls = 'team picked';
      if (res.winner) cls = res.winner === pick ? 'team correct' : 'team eliminated';
      el.innerHTML = `<div class="${cls}"><span>${escapeHtml(pick || 'TBD')}</span>` +
        `<span class="tag">${res.winner ? (res.winner === pick ? '✓' : 'actual: ' + escapeHtml(res.winner)) : 'pending'}</span></div>`;
      grid.appendChild(el);
    }
    sec.appendChild(grid); root.appendChild(sec);
  }
  const post = qs('#post-actions'); post.classList.remove('hidden');
  qs('#leaderboard-link').href = `/leaderboard.html?group=${data.groupCode}`;
  qs('#share-btn').addEventListener('click', () => navigator.clipboard.writeText(location.href));
}

function matchEl(slotId, home, away, picked, onPick) {
  const el = document.createElement('div'); el.className = 'match';
  el.appendChild(teamEl(slotId, home, picked, onPick));
  el.appendChild(teamEl(slotId, away, picked, onPick));
  return el;
}
function teamEl(slotId, team, picked, onPick) {
  const b = document.createElement('button');
  if (!team) { b.className = 'team tbd'; b.textContent = 'TBD'; b.disabled = true; return b; }
  b.className = 'team' + (picked === team ? ' picked' : '');
  b.innerHTML = `<span>${escapeHtml(team)}</span>`;
  b.addEventListener('click', () => onPick(slotId, team));
  return b;
}

// ---------- Leaderboard ----------
function initLeaderboard() {
  const group = param('group');
  if (!group) { qs('#lb-body').innerHTML = '<tr><td colspan="4">No group specified.</td></tr>'; return; }
  qs('#lb-title').textContent = `Leaderboard · ${group}`;
  const load = async () => {
    try {
      const { leaderboard } = await api(`/api/leaderboard/${group}`);
      const body = qs('#lb-body');
      if (!leaderboard.length) { body.innerHTML = '<tr><td colspan="4" class="muted">No brackets yet.</td></tr>'; return; }
      body.innerHTML = leaderboard.map((r) =>
        `<tr><td>${r.rank}</td><td><a href="/bracket.html?id=${r.bracketId}&view=1">${escapeHtml(r.userName)}</a></td>` +
        `<td><b>${r.totalPoints}</b></td><td>${r.correctPicks}</td></tr>`).join('');
    } catch (e) { qs('#lb-body').innerHTML = `<tr><td colspan="4">${e.message}</td></tr>`; }
  };
  load();
  setInterval(load, 15000);
}

function sizeOf(round) {
  return { r32: 16, r16: 8, qf: 4, sf: 2, final: 1, third: 1 }[round];
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
