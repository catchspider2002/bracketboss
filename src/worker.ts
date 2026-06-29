// BracketBoss — Cloudflare Worker (API + cron). Frontend served from /public via [assets].
import { allNodes, feedersOf, PLACEHOLDER_TEAMS, Round } from './bracketTree';
import { MatchRow, propagate, validateBracket, Picks } from './bracketEngine';
import { scoreBracket } from './scorer';
import { listWorldCupFixtures, fetchResult, TxFixture } from './txline';
import { R32_DRAW, slotForTeams } from './bracket2026';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TXLINE_API_KEY?: string;
  ADMIN_KEY?: string;
  GOOGLE_CLIENT_ID?: string; // optional — enables "Sign in with Google" cross-device sync
}

// Verify a Google Identity Services ID token and return the stable user id (sub).
// Uses Google's tokeninfo endpoint (validates signature + expiry); we check the audience.
async function verifyGoogle(idToken: string | undefined, env: Env): Promise<{ sub: string; email?: string; name?: string } | null> {
  if (!idToken || !env.GOOGLE_CLIENT_ID) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!r.ok) return null;
    const p = await r.json() as { aud?: string; sub?: string; email?: string; name?: string };
    if (!p.sub || p.aud !== env.GOOGLE_CLIENT_ID) return null;
    return { sub: String(p.sub), email: p.email, name: p.name };
  } catch { return null; }
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

  // Cron: for each knockout slot mapped to a TxLINE fixture, apply the winner on full time and
  // propagate it forward. Matches lock per-match (in the builder) once they have a result — there
  // is no global bracket lock. No-op until fixtures are mapped (see auto-seed / /api/admin/map).
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await ensureSeeded(env);
    if (!env.TXLINE_API_KEY) return; // not wired yet — nothing to poll
    const matches = await loadMatches(env);
    const mapped = Object.values(matches).filter((m) => m.match_id && !m.result_winner);
    for (const m of mapped) {
      try {
        const r = await fetchResult(env, m.match_id!);
        if (r.finished && r.winner) {
          const winnerName = r.winner === 'p1' ? m.home_slot : m.away_slot;
          if (winnerName) await applyResult(env, m.slot_id, winnerName, `${r.p1Goals}-${r.p2Goals}`);
        }
      } catch (e) { console.log('poll error', m.slot_id, String(e)); }
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
    if (await isLocked(env)) return json({ error: 'Brackets are locked.' }, 423);
    const body = await req.json().catch(() => ({})) as {
      groupCode?: string; userName?: string; picks?: Picks; odds?: unknown; idToken?: string;
    };
    if (!body.groupCode || !body.userName || !body.picks) {
      return json({ error: 'groupCode, userName and picks are required' }, 400);
    }
    const code = body.groupCode.toUpperCase();
    const grp = await env.DB.prepare('SELECT code FROM groups WHERE code = ?').bind(code).first();
    if (!grp) return json({ error: 'Group not found' }, 404);

    // Optional: if signed in with Google, tie this bracket to the account for cross-device recall.
    const owner = (await verifyGoogle(body.idToken, env))?.sub ?? null;

    // Force completed matches to the real winner — you can't submit a wrong pick for a played game.
    const matches = await loadMatches(env);
    const picks: Picks = { ...body.picks };
    for (const m of Object.values(matches)) {
      if (m.result_winner) picks[m.slot_id] = m.result_winner;
    }

    const { valid, errors } = validateBracket(picks);
    if (!valid) return json({ error: 'Invalid bracket', errors }, 400);

    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO brackets (id, group_code, user_name, picks_json, odds_json, wallet, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, code, body.userName, JSON.stringify(picks),
        body.odds ? JSON.stringify(body.odds) : null, owner, new Date().toISOString()).run();

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

  // GET /api/config — public config for the frontend (Google client id, if configured)
  if (path === '/api/config' && method === 'GET') {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID ?? null });
  }

  // POST /api/my { idToken } — brackets + groups for the signed-in Google account (cross-device recall)
  if (path === '/api/my' && method === 'POST') {
    const body = await req.json().catch(() => ({})) as { idToken?: string };
    const user = await verifyGoogle(body.idToken, env);
    if (!user) return json({ brackets: [], groups: [] });
    const rows = await env.DB.prepare(
      'SELECT id, group_code, user_name FROM brackets WHERE wallet = ? ORDER BY created_at DESC').bind(user.sub).all<any>();
    const brackets = (rows.results || []).map((r) => ({ bracketId: r.id, groupCode: r.group_code, userName: r.user_name }));
    const groups = [...new Set(brackets.map((b) => b.groupCode))].map((code) => ({ code }));
    return json({ brackets, groups });
  }

  // POST /api/mock-result  { slotId, winner, score }  — demo driver (stands in for TxLINE full_time)
  if (path === '/api/mock-result' && method === 'POST') {
    const body = await req.json().catch(() => ({})) as { slotId?: string; winner?: string; score?: string };
    if (!body.slotId || !body.winner) return json({ error: 'slotId and winner are required' }, 400);
    const changed = await applyResult(env, body.slotId, body.winner, body.score || '');
    return json({ changed });
  }

  // POST /api/lock — manually lock (e.g. to test)
  if (path === '/api/lock' && method === 'POST') {
    await setLocked(env);
    return json({ locked: true });
  }

  // ---- Admin (gated by header X-Admin-Key === env.ADMIN_KEY) ----
  if (path.startsWith('/api/admin/')) {
    if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
      return json({ error: 'forbidden' }, 403);
    }

    // GET /api/admin/fixtures?competitionId= — list World Cup fixtures from TxLINE (to find ids)
    if (path === '/api/admin/fixtures' && method === 'GET') {
      const cid = url.searchParams.get('competitionId');
      const fixtures = await listWorldCupFixtures(env, cid ? Number(cid) : undefined);
      return json({ fixtures });
    }

    // POST /api/admin/seed-teams { teams:[32] }  or  { r32:[{slotId,home,away}] } — real R32 draw
    if (path === '/api/admin/seed-teams' && method === 'POST') {
      const b = await req.json().catch(() => ({})) as { teams?: string[]; r32?: { slotId: string; home: string; away: string }[] };
      const updates: { slotId: string; home: string; away: string }[] = [];
      if (Array.isArray(b.r32)) updates.push(...b.r32);
      else if (Array.isArray(b.teams) && b.teams.length === 32) {
        for (let i = 0; i < 16; i++) updates.push({ slotId: `r32_${i}`, home: b.teams[2 * i], away: b.teams[2 * i + 1] });
      } else return json({ error: 'provide teams[32] or r32[]' }, 400);
      for (const u of updates) {
        await env.DB.prepare('UPDATE matches SET home_slot=?, away_slot=? WHERE slot_id=? AND round=?')
          .bind(u.home, u.away, u.slotId, 'r32').run();
      }
      return json({ updated: updates.length });
    }

    // GET/POST /api/admin/auto-seed-r32 — one-shot: seed the OFFICIAL 2026 Round-of-32 draw.
    //   Each TxLINE fixture is matched to its true bracket slot by team names (R32_DRAW), so the
    //   pairings are correct automatically — no kickoff-order guessing, robust to missing fixtures.
    //   Slots whose fixture is matched also get match_id + kickoff (wires the cron) and, if the
    //   match is already finished, the winner is applied immediately. Slots with no live fixture
    //   still get the real team names from the draw (so the bracket is complete).
    //   GET (or POST without apply:true) = PREVIEW only. POST { apply:true } writes.
    if (path === '/api/admin/auto-seed-r32' && (method === 'POST' || method === 'GET')) {
      if (await isLocked(env)) return json({ error: 'Brackets are locked — cannot reseed R32.' }, 423);
      const b = method === 'POST'
        ? (await req.json().catch(() => ({})) as { competitionId?: number; apply?: boolean })
        : {};
      const cidParam = url.searchParams.get('competitionId');
      const cid = b.competitionId ?? (cidParam ? Number(cidParam) : undefined);
      const all = await listWorldCupFixtures(env, cid);

      // Match each fixture to its official bracket slot by team names.
      const fixtureForSlot = new Map<string, TxFixture>();
      const unmatched: { fixtureId: number; teams: string; kickoff: string }[] = [];
      for (const f of all) {
        const d = slotForTeams(f.p1, f.p2);
        if (d && !fixtureForSlot.has(d.slot)) fixtureForSlot.set(d.slot, f);
        else if (!d) unmatched.push({ fixtureId: f.fixtureId, teams: `${f.p1} vs ${f.p2}`, kickoff: new Date(f.startTime).toISOString() });
      }

      // Build the full 16-slot plan from the official draw; attach live fixture where we have one.
      const assignments = R32_DRAW.map((d) => {
        const f = fixtureForSlot.get(d.slot);
        return {
          slotId: d.slot, matchNo: d.matchNo,
          home: f ? f.p1 : d.teams[0], away: f ? f.p2 : d.teams[1],
          fixtureId: f ? f.fixtureId : null,
          kickoff: f ? new Date(f.startTime).toISOString() : null,
          hasFixture: !!f,
          knownResult: f ? null : (d.result ?? null), // fallback result for an aged-out finished match
        };
      });
      const withFixture = assignments.filter((a) => a.hasFixture).length;
      // "Missing" = no live fixture AND no known result baked into the draw (truly unresolved).
      const missing = assignments.filter((a) => !a.hasFixture && !a.knownResult).map((a) => `${a.slotId} (${a.home} vs ${a.away})`);

      const apply = method === 'POST' && b.apply === true;
      const results: { slotId: string; winner: string; score: string }[] = [];
      if (apply) {
        // 1) Seed every R32 slot with real teams (+ fixture id + kickoff where available).
        for (const a of assignments) {
          await env.DB.prepare(
            'UPDATE matches SET home_slot=?, away_slot=?, match_id=?, kickoff=? WHERE slot_id=? AND round=?')
            .bind(a.home, a.away, a.fixtureId ? String(a.fixtureId) : null, a.kickoff, a.slotId, 'r32').run();
        }
        // 2) Immediately mark winners for any R32 match already finished (and propagate forward).
        //    No global lock — brackets stay open; completed matches are locked per-match in the
        //    builder (pre-selected to the real winner, not editable) and enforced on submit.
        for (const a of assignments) {
          if (a.fixtureId) {
            try {
              const r = await fetchResult(env, a.fixtureId);
              if (r.finished && r.winner) {
                const winnerName = r.winner === 'p1' ? a.home : a.away;
                const score = `${r.p1Goals}-${r.p2Goals}`;
                await applyResult(env, a.slotId, winnerName, score);
                results.push({ slotId: a.slotId, winner: winnerName, score });
              }
            } catch (e) { console.log('seed result error', a.slotId, String(e)); }
          } else if (a.knownResult) {
            // Finished match that aged out of the snapshot — apply the result from the draw data.
            await applyResult(env, a.slotId, a.knownResult.winner, a.knownResult.score);
            results.push({ slotId: a.slotId, winner: a.knownResult.winner, score: a.knownResult.score });
          }
        }
      }
      return json({
        applied: apply, seeded: assignments.length, withFixture,
        missingFixtures: missing, results, locked: await isLocked(env),
        unmatchedFixtures: unmatched,
        note: `Seeded the official 2026 R32 draw into correct bracket positions by team name. `
          + `${withFixture}/16 slots have a live TxLINE fixture (cron will post their results); `
          + `${missing.length} slot(s) have teams only (no live fixture yet) — they'll auto-wire when the fixture appears, or use /api/admin/map. `
          + (unmatched.length ? `${unmatched.length} TxLINE fixture(s) didn't match any draw pair (likely a name alias — see unmatchedFixtures).` : `All fixtures matched the draw.`),
        assignments,
      });
    }

    // POST /api/admin/map { slotId, fixtureId, home?, away?, kickoff? } — link a slot to a TxLINE fixture.
    // Set home/away to the TxLINE Participant1/Participant2 names so winner resolves correctly.
    if (path === '/api/admin/map' && method === 'POST') {
      const b = await req.json().catch(() => ({})) as { slotId?: string; fixtureId?: string | number; home?: string; away?: string; kickoff?: string };
      if (!b.slotId || b.fixtureId == null) return json({ error: 'slotId and fixtureId required' }, 400);
      await env.DB.prepare(
        'UPDATE matches SET match_id=?, home_slot=COALESCE(?,home_slot), away_slot=COALESCE(?,away_slot), kickoff=COALESCE(?,kickoff) WHERE slot_id=?')
        .bind(String(b.fixtureId), b.home ?? null, b.away ?? null, b.kickoff ?? null, b.slotId).run();
      return json({ ok: true });
    }

    return json({ error: 'unknown admin route' }, 404);
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
