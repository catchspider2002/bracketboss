// BracketBoss — TxLINE integration point.
//
// SCOPE: BracketBoss only needs two things from TxLINE, both on the 32 knockout
// matches (sparse, scheduled) — so this runs from the Worker cron, no Container:
//   1) KICKOFF of the first knockout match  -> lock all bracket submissions
//   2) FULL_TIME on any knockout match      -> record winner, propagate, rescore
//
// The functions below are STUBBED. Wire them to the real TxLINE endpoints once you
// have your API key + confirmed field names:
//   World Cup docs: https://txline.txodds.com/documentation/worldcup
//
// Until then, drive results in the demo via  POST /api/mock-result.

export interface KnockoutUpdate {
  slotId: string;         // our bracket slot, e.g. 'qf_1' (requires a matchId->slotId mapping you set when seeding the real draw)
  status: 'scheduled' | 'live' | 'finished';
  kickoff?: string;
  winner?: string;        // present when finished
  score?: string;
}

/**
 * Poll TxLINE for knockout fixtures + results.
 * TODO: replace the stub with a real fetch to TxLINE using env.TXLINE_API_KEY,
 * map each TxLINE matchId to our slot_id, and return any kickoffs/full_times.
 */
export async function pollKnockout(env: { TXLINE_API_KEY?: string }): Promise<KnockoutUpdate[]> {
  if (!env.TXLINE_API_KEY) return [];
  // Example shape (do NOT ship as-is — confirm the real endpoint/fields):
  //
  // const res = await fetch(`${BASE}/worldcup/fixtures?stage=knockout`, {
  //   headers: { Authorization: `Bearer ${env.TXLINE_API_KEY}` },
  // });
  // const data = await res.json();
  // return data.matches.map(m => ({ slotId: mapMatchToSlot(m.id), status: m.status,
  //   kickoff: m.kickoff, winner: m.result?.winner, score: m.result?.score }));
  return [];
}
