// BracketBoss - TxLINE API client (auth + fixtures + scores → winner).
//
// Auth: every data call needs BOTH headers:
//   Authorization: Bearer <guest JWT>   (30-day, fetched server-side, cached in D1 `meta`)
//   X-Api-Token:   <your activated token = env.TXLINE_API_KEY>
// Docs: https://txline-docs.txodds.com (fixtures/snapshot, scores/snapshot/{fixtureId})

const BASE = 'https://txline.txodds.com';

export interface TxEnv { DB: D1Database; TXLINE_API_KEY?: string }

// ---- JWT cache in the meta table ----
async function metaGet(env: TxEnv, k: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(k).first<{ value: string }>();
  return r?.value ?? null;
}
async function metaSet(env: TxEnv, k: string, v: string): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind(k, v).run();
}

async function getJwt(env: TxEnv, force = false): Promise<string> {
  if (!force) {
    const v = await metaGet(env, 'txline_jwt');
    const at = await metaGet(env, 'txline_jwt_at');
    if (v && at && Date.now() - Number(at) < 25 * 864e5) return v; // refresh before 30-day expiry
  }
  const r = await fetch(`${BASE}/auth/guest/start`, { method: 'POST' });
  if (!r.ok) throw new Error('guest start failed: ' + r.status);
  const token = (await r.json() as { token: string }).token;
  await metaSet(env, 'txline_jwt', token);
  await metaSet(env, 'txline_jwt_at', String(Date.now()));
  return token;
}

async function authedGet(env: TxEnv, path: string): Promise<Response> {
  if (!env.TXLINE_API_KEY) throw new Error('TXLINE_API_KEY not set');
  let jwt = await getJwt(env);
  const headers = () => ({ Authorization: `Bearer ${jwt}`, 'X-Api-Token': env.TXLINE_API_KEY! });
  let res = await fetch(BASE + path, { headers: headers() });
  if (res.status === 401) { jwt = await getJwt(env, true); res = await fetch(BASE + path, { headers: headers() }); }
  return res;
}

// ---- Fixtures ----
export interface TxFixture {
  fixtureId: number; competition: string; competitionId: number; startTime: number;
  p1: string; p1Id: number; p2: string; p2Id: number; p1IsHome: boolean;
}

// Strict match for the SENIOR MEN's FIFA World Cup only - excludes the many other
// "World Cup" competitions TxLINE returns (qualifiers, U-17/U-20/youth, women's,
// Club World Cup, beach/futsal/esports). This is what made auto-seed look wrong.
export function isMainWorldCup(name: string): boolean {
  const s = (name || '').toLowerCase();
  if (!/world cup/.test(s)) return false;
  if (/qualif|wom(e|a)n|u-?\d{1,2}|under[\s-]?\d{1,2}|youth|club|beach|futsal|esoccer|e-?sports|e[\s-]?world/.test(s)) return false;
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (year && year[0] !== '2026') return false; // keep only the 2026 edition
  return true;
}

export async function listWorldCupFixtures(env: TxEnv, competitionId?: number): Promise<TxFixture[]> {
  const q = competitionId ? `?competitionId=${competitionId}` : '';
  const res = await authedGet(env, '/api/fixtures/snapshot' + q);
  if (!res.ok) throw new Error('fixtures ' + res.status + ' ' + (await res.text()));
  const arr = await res.json() as any[];
  return arr.map((f) => ({
    fixtureId: f.FixtureId, competition: f.Competition, competitionId: f.CompetitionId,
    startTime: f.StartTime, p1: f.Participant1, p1Id: f.Participant1Id,
    p2: f.Participant2, p2Id: f.Participant2Id, p1IsHome: f.Participant1IsHome,
  })).filter((f) => (competitionId ? true : isMainWorldCup(f.competition || '')));
}

// ---- Scores -> result ----
export interface TxResult {
  started: boolean; finished: boolean; winner: 'p1' | 'p2' | null;
  p1Goals: number; p2Goals: number; phase: string;
}

const FINISHED = new Set(['F', 'FET', 'FPE']);

export async function fetchResult(env: TxEnv, fixtureId: string | number): Promise<TxResult> {
  const res = await authedGet(env, `/api/scores/snapshot/${fixtureId}`);
  if (!res.ok) throw new Error('scores ' + res.status);
  const arr = await res.json() as any[];
  if (!Array.isArray(arr) || arr.length === 0) {
    return { started: false, finished: false, winner: null, p1Goals: 0, p2Goals: 0, phase: 'NS' };
  }
  // Phase comes from the Action timeline (GameState is always "scheduled"); goals from the
  // most recent record that actually carries Stats.
  const phase = phaseFromActions(arr);
  const rec = latestStatRec(arr);
  const started = phase !== 'NS';
  const finished = FINISHED.has(phase);
  const { p1, p2 } = goalsOf(rec);
  let winner: 'p1' | 'p2' | null = null;
  if (finished) {
    if (p1 > p2) winner = 'p1';
    else if (p2 > p1) winner = 'p2';
    else { const pen = penGoalsOf(rec); winner = pen.p1 > pen.p2 ? 'p1' : pen.p2 > pen.p1 ? 'p2' : null; }
  }
  return { started, finished, winner, p1Goals: p1, p2Goals: p2, phase };
}

// Diagnostic: return a compact timeline of the scores records so we can see how GameState
// (and Action) progress across the match, plus the distinct GameState/Action vocabularies.
export async function rawScores(env: TxEnv, fixtureId: string | number): Promise<any> {
  const res = await authedGet(env, `/api/scores/snapshot/${fixtureId}`);
  if (!res.ok) return { ok: false, status: res.status };
  const arr = await res.json() as any[];
  if (!Array.isArray(arr)) return { ok: true, nonArray: arr };
  const rows = arr.map((r) => ({ seq: r?.Seq, action: r?.Action, state: r?.GameState, score: `${r?.Stats?.['1'] ?? '?'}-${r?.Stats?.['2'] ?? '?'}` }))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return {
    ok: true, count: arr.length,
    gameStates: [...new Set(arr.map((r) => r?.GameState))],
    actions: [...new Set(arr.map((r) => r?.Action))],
    timeline: rows,
  };
}

// ---- phase from the Action timeline ----
// TxLINE's scores feed carries the match lifecycle in per-record `Action` values, not `GameState`
// (which stays "scheduled"). We map the set/order of Actions to a phase code. `game_finalised` is
// the terminal signal; a `kickoff` after `halftime_finalised` means the second half is underway.
// Stat keys: 1/2 = P1/P2 total goals, 5001/5002 = penalty-shootout goals.
function phaseFromActions(arr: any[]): string {
  let hasKick = false, htSeq = -1, finalised = false;
  for (const r of arr) {
    const a = String(r?.Action || '');
    const s = seqOf(r);
    if (a === 'kickoff' || a === 'kickoff_team') hasKick = true;
    if (a === 'halftime_finalised' && s > htSeq) htSeq = s;
    if (a === 'game_finalised') finalised = true;
  }
  if (finalised) return 'F';
  if (htSeq >= 0) {
    for (const r of arr) if (String(r?.Action || '') === 'kickoff' && seqOf(r) > htSeq) return 'H2';
    return 'HT';
  }
  return hasKick ? 'H1' : 'NS';
}
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
function seqOf(u: any): number { return num(u?.Seq ?? u?.seq ?? u?.Timestamp ?? u?.timestamp ?? u?.Ts ?? u?.ts); }
function hasStats(u: any): boolean { const s = u?.Stats ?? u?.stats; return !!s && typeof s === 'object' && (s['1'] != null || s['2'] != null); }
function latestStatRec(arr: any[]): any {
  let best: any = null;
  for (const r of arr) if (hasStats(r) && (!best || seqOf(r) > seqOf(best))) best = r;
  return best ?? (arr.length ? arr.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)) : {});
}
function statMap(u: any): Map<number, number> {
  const m = new Map<number, number>();
  const s = u?.Stats ?? u?.stats;
  if (Array.isArray(s)) { for (const it of s) { const k = Number(it?.Key ?? it?.key ?? it?.[0]); if (Number.isFinite(k)) m.set(k, num(it?.Value ?? it?.value ?? it?.[1])); } }
  else if (s && typeof s === 'object') { for (const k of Object.keys(s)) { const kn = Number(k); if (Number.isFinite(kn)) m.set(kn, num((s as any)[k])); } }
  return m;
}
function goalsOf(u: any): { p1: number; p2: number } {
  const sm = statMap(u); const sc = u?.ScoreSoccer ?? u?.scoreSoccer;
  return { p1: sm.get(1) ?? num(sc?.Participant1?.Total?.Goals), p2: sm.get(2) ?? num(sc?.Participant2?.Total?.Goals) };
}
function penGoalsOf(u: any): { p1: number; p2: number } {
  const sm = statMap(u); const sc = u?.ScoreSoccer ?? u?.scoreSoccer;
  return { p1: sm.get(5001) ?? num(sc?.Participant1?.PE?.Goals), p2: sm.get(5002) ?? num(sc?.Participant2?.PE?.Goals) };
}
