// BracketBoss — TxLINE API client (auth + fixtures + scores → winner).
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

// Strict match for the SENIOR MEN's FIFA World Cup only — excludes the many other
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
  // Most recent update wins (highest seq, then ts).
  const latest = arr.reduce((a, b) => ((b?.seq ?? b?.ts ?? 0) > (a?.seq ?? a?.ts ?? 0) ? b : a));
  const phase = phaseOf(latest);
  const started = phase !== 'NS';
  const finished = FINISHED.has(phase);
  const { p1, p2 } = goalsOf(latest);
  let winner: 'p1' | 'p2' | null = null;
  if (finished) {
    if (p1 > p2) winner = 'p1';
    else if (p2 > p1) winner = 'p2';
    else { const pen = penGoalsOf(latest); winner = pen.p1 > pen.p2 ? 'p1' : pen.p2 > pen.p1 ? 'p2' : null; }
  }
  return { started, finished, winner, p1Goals: p1, p2Goals: p2, phase };
}

// ---- defensive field extraction (serialization of enums/stats can vary) ----
function phaseOf(u: any): string {
  if (typeof u?.gameState === 'string' && u.gameState) return u.gameState;
  const s = u?.statusSoccerId;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') return Object.keys(s)[0] || 'NS';
  return 'NS';
}
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
function goalsOf(u: any): { p1: number; p2: number } {
  const st = u?.stats || {};
  if (st['1'] != null || st['2'] != null) return { p1: num(st['1']), p2: num(st['2']) };
  const sc = u?.scoreSoccer;
  return {
    p1: num(sc?.Participant1?.Total?.Goals),
    p2: num(sc?.Participant2?.Total?.Goals),
  };
}
function penGoalsOf(u: any): { p1: number; p2: number } {
  const st = u?.stats || {};
  if (st['5001'] != null || st['5002'] != null) return { p1: num(st['5001']), p2: num(st['5002']) };
  const sc = u?.scoreSoccer;
  return { p1: num(sc?.Participant1?.PE?.Goals), p2: num(sc?.Participant2?.PE?.Goals) };
}
