// BracketBoss — Cloudflare Worker (API + cron). Frontend served from /public via [assets].
import { allNodes, feedersOf, PLACEHOLDER_TEAMS, Round } from './bracketTree';
import { MatchRow, propagate, validateBracket, Picks } from './bracketEngine';
import { scoreBracket } from './scorer';
import { pollKnockout } from './txline';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TXLINE_API_KEY?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Static assets (HTML/CSS/JS) for anything not under /api.
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      await ensureSeeded(env);
      return await route(req, env, url);
    } catch (err) {
      return json({ error: String((err as Error).message || err) }, 500);
    }
  },

  // Cron: poll TxLINE for knockout kickoffs (lock) + full_times (results).
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await ensureSeeded(env);
    const updates = await pollKnockout(env);
    for (const u of updates) {
      if (u.status !== 'finished' && !(await isLocked(env))) {
        await setLocked(env); // first kickoff locks submissions
      }
      if (u.status === 'finished' && u.winner) {
        await applyResult(env, u.slotId, u.winner, u.score || '');
      }
    }
  },
};

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // POST /api/group
  if (path === '/api/group' && method === 'POST') {
    const body = await req.json().catch(() => ({})) as { name?: string };
    const code = await uniqueCode(env);
    await env.DB.prepare('INSERT INTO groups (code, name, created_at) VALUES (?, ?, ?)')
      .bind(code, body.name ?? null, new Date().toISOString()).run();
    return json({ code });
  }

  // GET /api/group/:code
  let m = path.match(/^\/api\/group\/([A-Za-z0-9]+)$/);
  if (m && method === 'GET') {
    const code = m[1].toUpperCase();
    const grp = await env.DB.prepare('SELECT code, name FROM groups WHERE code = ?').bind(code).first();
    if (!grp) return json({ error: 'Group not found' }, 404);
    const members = await env.DB.prepare(
      'SELECT id, user_name FROM brackets WHERE group_code = ? ORDER BY created_at').bind(code).all();
    return json({ group: grp, members: members.results, locked: await isLocked(env) });
  }

  // GET /api/matches/knockout
  if (path === '/api/matches/knockout' && method === 'GET') {
    const matches = await loadMatches(env);
    const nodes = allNodes().map((n) => {
      const row = matches[n.slotId];
      return {
        slotId: n.slotId, round: n.round, slotIndex: n.slotIndex,
        home: row?.home_slot ?? null, away: row?.away_slot ?? null,
        winner: row?.result_winner ?? null, score: row?.result_score ?? null,
      };
    });
    return json({ locked: await isLocked(env), lockAt: await meta(env, 'lock_at'), nodes });
  }

  // POST /api/bracket
  if (path === '/api/bracket' && method === 'POST') {
    if (await isLocked(env)) return json({ error: 'Brackets are locked — the knockout stage has started.' }, 423);
    const body = await req.json().catch(() => ({})) as {
      groupCode?: string; userName?: string; picks?: Picks; odds?: unknown;
    };
    if (!body.groupCode || !body.userName || !body.picks) {
      return json({ error: 'groupCode, userName and picks are required' }, 400);
    }
    const code = body.groupCode.toUpperCase();
    const grp = await env.DB.prepare('SELECT code FROM groups WHERE code = ?').bind(code).first();
    if (!grp) return json({ error: 'Group not found' }, 404);

    const { valid, errors } = validateBracket(body.picks);
    if (!valid) return json({ error: 'Invalid bracket', errors }, 400);

    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO brackets (id, group_code, user_name, picks_json, odds_json, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, code, body.userName, JSON.stringify(body.picks),
        body.odds ? JSON.stringify(body.odds) : null, new Date().toISOString()).run();

    const shareUrl = `${new URL(req.url).origin}/bracket.html?id=${id}&view=1`;
    return json({ bracketId: id, shareUrl });
  }

  // GET /api/bracket/:id
  m = path.match(/^\/api\/bracket\/([0-9a-fA-F-]+)$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT id, group_code, user_name, picks_json, odds_json FROM brackets WHERE id = ?').bind(m[1]).first<any>();
    if (!row) return json({ error: 'Bracket not found' }, 404);
    const picks = JSON.parse(row.picks_json) as Picks;
    const odds = row.odds_json ? JSON.parse(row.odds_json) : null;
    const matches = await loadMatches(env);
    const score = scoreBracket(picks, odds, matches);
    return json({
      bracketId: row.id, groupCode: row.group_code, userName: row.user_name,
      picks, score,
      results: Object.fromEntries(Object.values(matches).map((r) => [r.slot_id,
        { winner: r.result_winner, home: r.home_slot, away: r.away_slot }])),
    });
  }

  // GET /api/leaderboard/:code
  m = path.match(/^\/api\/leaderboard\/([A-Za-z0-9]+)$/);
  if (m && method === 'GET') {
    const code = m[1].toUpperCase();
    const matches = await loadMatches(env);
    const rows = await env.DB.prepare(
      'SELECT id, user_name, picks_json, odds_json FROM brackets WHERE group_code = ?').bind(code).all<any>();
    const ranked = (rows.results || []).map((r) => {
      const s = scoreBracket(JSON.parse(r.picks_json), r.odds_json ? JSON.parse(r.odds_json) : null, matches);
      return { bracketId: r.id, userName: r.user_name, totalPoints: s.total, correctPicks: s.correctPicks };
    }).sort((a, b) => b.totalPoints - a.totalPoints)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    return json({ groupCode: code, leaderboard: ranked });
  }

  // POST /api/mock-result  { slotId, winner, score }  — demo driver (stands in for TxLINE full_time)
  if (path === '/api/mock-result' && method === 'POST') {
    const body = await req.json().catch(() => ({})) as { slotId?: string; winner?: string; score?: string };
    if (!body.slotId || !body.winner) return json({ error: 'slotId and winner are required' }, 400);
    if (!(await isLocked(env))) await setLocked(env); // a result means the stage has started
    const changed = await applyResult(env, body.slotId, body.winner, body.score || '');
    return json({ changed });
  }

  // POST /api/lock — manually lock (e.g. to test)
  if (path === '/api/lock' && method === 'POST') {
    await setLocked(env);
    return json({ locked: true });
  }

  return json({ error: 'Not found' }, 404);
}

// ---- data helpers ----

async function applyResult(env: Env, slotId: string, winner: string, score: string): Promise<string[]> {
  const matches = await loadMatches(env);
  if (!matches[slotId]) return [];
  const changed = propagate(matches, slotId, winner, score);
  for (const id of changed) {
    const r = matches[id];
    await env.DB.prepare(
      'UPDATE matches SET home_slot=?, away_slot=?, result_winner=?, result_score=? WHERE slot_id=?')
      .bind(r.home_slot, r.away_slot, r.result_winner, r.result_score, id).run();
  }
  return changed;
}

async function loadMatches(env: Env): Promise<Record<string, MatchRow>> {
  const res = await env.DB.prepare('SELECT * FROM matches').all<MatchRow>();
  const map: Record<string, MatchRow> = {};
  for (const r of res.results || []) map[r.slot_id] = r;
  return map;
}

async function ensureSeeded(env: Env): Promise<void> {
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM matches').first<{ c: number }>();
  if (count && count.c > 0) return;
  const stmts: D1PreparedStatement[] = [];
  for (const n of allNodes()) {
    let home: string, away: string;
    if (n.round === 'r32') {
      home = PLACEHOLDER_TEAMS[n.slotIndex * 2] ?? `Seed ${n.slotIndex * 2 + 1}`;
      away = PLACEHOLDER_TEAMS[n.slotIndex * 2 + 1] ?? `Seed ${n.slotIndex * 2 + 2}`;
    } else {
      const f = feedersOf(n.slotId);
      home = `winner_of_${f[0]}`;
      away = `winner_of_${f[1]}`;
    }
    stmts.push(env.DB.prepare(
      'INSERT INTO matches (slot_id, round, slot_index, home_slot, away_slot) VALUES (?,?,?,?,?)')
      .bind(n.slotId, n.round, n.slotIndex, home, away));
  }
  await env.DB.batch(stmts);
}

async function meta(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function isLocked(env: Env): Promise<boolean> {
  return (await meta(env, 'locked')) === '1';
}
async function setLocked(env: Env): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind('locked', '1').run();
  await env.DB.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .bind('lock_at', new Date().toISOString()).run();
}

async function uniqueCode(env: Env): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    for (const b of bytes) code += alphabet[b % alphabet.length];
    const exists = await env.DB.prepare('SELECT 1 FROM groups WHERE code = ?').bind(code).first();
    if (!exists) return code;
  }
  throw new Error('Could not allocate a unique group code');
}
