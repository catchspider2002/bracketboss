// BracketBoss frontend - one script for all three pages.
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

// ---------- local storage: remember groups, brackets, Google session ----------
const store = {
  get(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  addGroup(code) {
    if (!code) return; const g = store.get('bb_groups', []);
    if (!g.includes(code)) { g.unshift(code); store.set('bb_groups', g.slice(0, 50)); }
  },
  addBracket(b) {
    const list = store.get('bb_brackets', []);
    if (!list.find((x) => x.bracketId === b.bracketId)) { list.unshift(b); store.set('bb_brackets', list.slice(0, 50)); }
  },
  groups() { return store.get('bb_groups', []); },
  brackets() { return store.get('bb_brackets', []); },
  token() { return localStorage.getItem('bb_gtoken') || null; },
  setToken(t) { t ? localStorage.setItem('bb_gtoken', t) : localStorage.removeItem('bb_gtoken'); },
  profile() { return store.get('bb_gprofile', null); },
  setProfile(p) { p ? store.set('bb_gprofile', p) : localStorage.removeItem('bb_gprofile'); },
};

// ---------- Google sign-in (optional, for cross-device sync) ----------
let GOOGLE_CLIENT_ID = null;

function decodeJwt(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

async function initAuth() {
  try { const cfg = await api('/api/config'); GOOGLE_CLIENT_ID = cfg.googleClientId || null; } catch { GOOGLE_CLIENT_ID = null; }
  injectAuthUI();
}

function onGoogleCredential(resp) {
  const token = resp && resp.credential; if (!token) return;
  const p = decodeJwt(token) || {};
  store.setToken(token);
  store.setProfile({ name: p.name || p.email || 'Account', email: p.email || '', picture: p.picture || '' });
  injectAuthUI();
  if (document.body.dataset.page === 'home') renderYourStuff();
}

function signOut() {
  store.setToken(null); store.setProfile(null);
  try { if (window.google) google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  injectAuthUI();
  if (document.body.dataset.page === 'home') renderYourStuff();
}

function injectAuthUI() {
  const bar = qs('.topbar'); if (!bar) return;
  let host = qs('#auth');
  if (!host) { host = document.createElement('div'); host.id = 'auth'; host.style.marginLeft = 'auto'; bar.appendChild(host); }
  host.innerHTML = '';
  if (!GOOGLE_CLIENT_ID) return; // sign-in disabled (not configured) - app works fully without it
  const prof = store.profile();
  if (store.token() && prof) {
    const span = document.createElement('span');
    span.className = 'muted'; span.style.cssText = 'font-size:13px;margin-right:8px';
    span.textContent = prof.name;
    const out = document.createElement('button'); out.className = 'btn secondary'; out.textContent = 'Sign out';
    out.addEventListener('click', signOut);
    host.appendChild(span); host.appendChild(out);
  } else {
    const mount = document.createElement('div'); host.appendChild(mount);
    const render = () => {
      if (!(window.google && google.accounts && google.accounts.id)) return false;
      google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
      google.accounts.id.renderButton(mount, { type: 'standard', theme: 'outline', size: 'medium', text: 'signin' });
      return true;
    };
    if (!render()) { let n = 0; const iv = setInterval(() => { if (render() || ++n > 40) clearInterval(iv); }, 100); }
  }
}

const page = document.body.dataset.page;
initAuth();
if (page === 'home') initHome();
if (page === 'bracket') initBracket();
if (page === 'leaderboard') initLeaderboard();

// ---------- Home ----------
function initHome() {
  renderYourStuff();
  qs('#create-btn').addEventListener('click', async () => {
    const out = qs('#create-out');
    try {
      const { code } = await api('/api/group', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: qs('#group-name').value || null }),
      });
      store.addGroup(code);
      out.innerHTML = `Group code: <b class="mono">${code}</b> - <a href="/bracket.html?group=${code}">build your bracket →</a><br>Share this code with friends.`;
      renderYourStuff();
    } catch (e) { out.textContent = e.message; }
  });
  qs('#join-btn').addEventListener('click', () => {
    const code = (qs('#join-code').value || '').trim().toUpperCase();
    if (code.length !== 6) { qs('#join-out').textContent = 'Enter a 6-character code.'; return; }
    store.addGroup(code);
    location.href = `/bracket.html?group=${code}`;
  });
}

async function renderYourStuff() {
  const host = qs('#your-stuff'); if (!host) return;
  let groups = store.groups().map((code) => ({ code }));
  let brackets = store.brackets();

  // Merge server-side records for the signed-in Google account (cross-device).
  const token = store.token();
  if (token) {
    try {
      const mine = await api('/api/my', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      });
      const codes = new Set(groups.map((g) => g.code));
      mine.groups.forEach((g) => { if (!codes.has(g.code)) groups.push(g); });
      const ids = new Set(brackets.map((b) => b.bracketId));
      mine.brackets.forEach((b) => { if (!ids.has(b.bracketId)) brackets.push(b); });
    } catch { /* ignore */ }
  }

  if (!groups.length && !brackets.length) { host.innerHTML = ''; return; }
  const groupRows = groups.map((g) =>
    `<li><b class="mono">${g.code}</b> · <a href="/bracket.html?group=${g.code}">build</a> · <a href="/leaderboard.html?group=${g.code}">leaderboard</a></li>`).join('');
  const bracketRows = brackets.map((b) =>
    `<li><a href="/bracket.html?id=${b.bracketId}&view=1">${escapeHtml(b.userName || 'bracket')}</a> · <span class="mono">${b.groupCode || ''}</span></li>`).join('');
  host.innerHTML =
    `<div class="panel"><h2>Your stuff</h2>` +
    (groupRows ? `<p class="muted" style="margin:6px 0 2px">Groups</p><ul class="ys">${groupRows}</ul>` : '') +
    (bracketRows ? `<p class="muted" style="margin:10px 0 2px">Brackets</p><ul class="ys">${bracketRows}</ul>` : '') +
    (token || !GOOGLE_CLIENT_ID ? '' : `<p class="muted" style="font-size:12.5px;margin-top:10px">Sign in with Google to keep these across devices.</p>`) +
    `</div>`;
}

// ---------- Bracket (builder + read-only view) ----------
function initBracket() {
  const id = param('id');
  if (id) return renderView(id);
  const group = param('group');
  if (!group) { qs('#bracket').innerHTML = '<p class="muted">No group specified. <a href="/">Go home</a>.</p>'; return; }
  store.addGroup(group);
  buildMode(group);
}

async function buildMode(group) {
  const data = await api('/api/matches/knockout');
  const seeds = {};
  data.nodes.forEach((n) => { if (n.round === 'r32') seeds[n.slotId] = { home: n.home, away: n.away }; });

  // Completed matches: result already decided → pre-selected and not editable.
  const locked = {}; // slotId -> winning team
  data.nodes.forEach((n) => { if (n.winner) locked[n.slotId] = n.winner; });

  if (data.locked) {
    qs('#status-bar').innerHTML = `Brackets are <b>locked</b>. <a href="/leaderboard.html?group=${group}">View leaderboard →</a>`;
    qs('#bracket').innerHTML = '<p class="muted">Submissions are closed for this tournament.</p>';
    return;
  }
  const lockedCount = Object.keys(locked).length;
  qs('#status-bar').innerHTML = `Group <b class="mono">${group}</b> - pick a winner in every match.`
    + (lockedCount ? ` <span class="muted">${lockedCount} completed match${lockedCount > 1 ? 'es are' : ' is'} already filled in.</span>` : '');
  qs('#builder-actions').classList.remove('hidden');

  const picks = {};
  Object.assign(picks, locked); // completed results are forced picks
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
          if (locked[s]) continue; // never drop a completed-match result
          if (picks[s] && !participants(s).includes(picks[s])) { delete picks[s]; changed = true; }
        }
      }
    }
  };
  const onPick = (slotId, team) => { if (!team || locked[slotId]) return; picks[slotId] = team; prune(); render(); };

  function render() {
    const root = qs('#bracket'); root.innerHTML = '';
    for (const round of ROUND_ORDER) {
      const sec = document.createElement('div'); sec.className = `round ${round}`;
      sec.innerHTML = `<h3>${ROUND_LABEL[round]}</h3>`;
      const grid = document.createElement('div'); grid.className = 'round-matches';
      for (let i = 0; i < sizeOf(round); i++) {
        const slotId = `${round}_${i}`;
        const [home, away] = participants(slotId);
        grid.appendChild(matchEl(slotId, home, away, picks[slotId], onPick, locked[slotId]));
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
        body: JSON.stringify({ groupCode: group, userName, picks, idToken: store.token() }),
      });
      store.addBracket({ bracketId, groupCode: group, userName });
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

  qs('#status-bar').innerHTML = `<b>${escapeHtml(data.userName)}</b>'s bracket - group <span class="mono">${data.groupCode}</span>`;
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

function matchEl(slotId, home, away, picked, onPick, lockedWinner) {
  const el = document.createElement('div'); el.className = 'match' + (lockedWinner ? ' done' : '');
  el.appendChild(teamEl(slotId, home, picked, onPick, lockedWinner));
  el.appendChild(teamEl(slotId, away, picked, onPick, lockedWinner));
  return el;
}
function teamEl(slotId, team, picked, onPick, lockedWinner) {
  const b = document.createElement('button');
  if (!team) { b.className = 'team tbd'; b.textContent = 'TBD'; b.disabled = true; return b; }
  if (lockedWinner) {
    // Completed match - winner pre-selected, both sides disabled.
    const isWinner = team === lockedWinner;
    b.className = 'team locked ' + (isWinner ? 'correct' : 'eliminated');
    b.disabled = true;
    b.innerHTML = `<span>${escapeHtml(team)}</span>` + (isWinner ? '<span class="tag">✓ result</span>' : '');
    return b;
  }
  b.className = 'team' + (picked === team ? ' picked' : '');
  b.innerHTML = `<span>${escapeHtml(team)}</span>`;
  b.addEventListener('click', () => onPick(slotId, team));
  return b;
}

// ---------- Leaderboard ----------
function initLeaderboard() {
  const group = param('group');
  if (!group) { qs('#lb-body').innerHTML = '<tr><td colspan="4">No group specified.</td></tr>'; return; }
  store.addGroup(group);
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
