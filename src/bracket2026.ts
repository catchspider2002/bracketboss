// BracketBoss - official 2026 FIFA World Cup Round-of-32 draw, mapped to our bracket-tree slots.
//
// The slot -> FIFA-match-number map is FIXED by the tournament regulations (Annex):
//   r32 slot order is derived from the R16 pairings so the tree advances correctly
//   (r32_0 & r32_1 -> r16_0, r16_0 & r16_1 -> qf_0, etc.). Verified against the official bracket.
// Match numbers 73-88 are the Round of 32; the teams below are the actual qualified teams
// (group stage complete, June 2026). Sources: FIFA regulations + press brackets (see README).

export interface DrawSlot {
  slot: string;
  matchNo: number;
  teams: [string, string];
  // Known final result, for matches that have already finished AND aged out of the TxLINE
  // fixtures snapshot (so the cron can't post them). `winner` must equal one of `teams`.
  // `score` is "home-away" relative to the `teams` order. Used only as a fallback when no
  // live fixture matches this slot.
  result?: { winner: string; score: string };
}

export const R32_DRAW: DrawSlot[] = [
  { slot: 'r32_0',  matchNo: 74, teams: ['Germany', 'Paraguay'] },
  { slot: 'r32_1',  matchNo: 77, teams: ['France', 'Sweden'] },
  { slot: 'r32_2',  matchNo: 73, teams: ['South Africa', 'Canada'], result: { winner: 'Canada', score: '0-1' } },
  { slot: 'r32_3',  matchNo: 75, teams: ['Netherlands', 'Morocco'] },
  { slot: 'r32_4',  matchNo: 83, teams: ['Portugal', 'Croatia'] },
  { slot: 'r32_5',  matchNo: 84, teams: ['Spain', 'Austria'] },
  { slot: 'r32_6',  matchNo: 81, teams: ['United States', 'Bosnia and Herzegovina'] },
  { slot: 'r32_7',  matchNo: 82, teams: ['Belgium', 'Senegal'] },
  { slot: 'r32_8',  matchNo: 76, teams: ['Brazil', 'Japan'] },
  { slot: 'r32_9',  matchNo: 78, teams: ['Ivory Coast', 'Norway'] },
  { slot: 'r32_10', matchNo: 79, teams: ['Mexico', 'Ecuador'] },
  { slot: 'r32_11', matchNo: 80, teams: ['England', 'DR Congo'] },
  { slot: 'r32_12', matchNo: 86, teams: ['Argentina', 'Cabo Verde'] },
  { slot: 'r32_13', matchNo: 88, teams: ['Australia', 'Egypt'] },
  { slot: 'r32_14', matchNo: 85, teams: ['Switzerland', 'Algeria'] },
  { slot: 'r32_15', matchNo: 87, teams: ['Colombia', 'Ghana'] },
];

// Map TxLINE team-name variants onto our canonical names so fixtures match the draw.
const ALIASES: Record<string, string> = {
  'usa': 'united states', 'us': 'united states', 'united states of america': 'united states',
  'congo dr': 'dr congo', 'dr congo': 'dr congo', 'democratic republic of the congo': 'dr congo',
  'drc': 'dr congo', 'congo democratic republic': 'dr congo', 'rd congo': 'dr congo',
  'bosnia': 'bosnia and herzegovina', 'bosnia herzegovina': 'bosnia and herzegovina',
  'cote divoire': 'ivory coast', 'cote d ivoire': 'ivory coast', 'cotedivoire': 'ivory coast',
  'cape verde': 'cabo verde',
  'korea republic': 'south korea', 'republic of korea': 'south korea', 'korea south': 'south korea',
  'czechia': 'czech republic',
};

export function normTeam(s: string): string {
  const x = (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  return ALIASES[x] || x;
}

const KEY = (a: string, b: string) => [normTeam(a), normTeam(b)].sort().join('|');

const BY_TEAMS = new Map<string, DrawSlot>();
for (const d of R32_DRAW) BY_TEAMS.set(KEY(d.teams[0], d.teams[1]), d);

// Find the bracket slot for a fixture by its two team names (order-independent). null if no match.
export function slotForTeams(p1: string, p2: string): DrawSlot | null {
  return BY_TEAMS.get(KEY(p1, p2)) || null;
}
