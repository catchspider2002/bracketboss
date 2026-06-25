// BracketBoss — knockout tree shape, scoring table, and forward/feeder helpers.
// The tree SHAPE is fixed by tournament rules regardless of which teams fill it.
// 2026 expanded format: 32 teams enter the knockout stage.
//   R32 (16) -> R16 (8) -> QF (4) -> SF (2) -> Final (1)  + Third-place play-off (1)
//   = 32 matches, one winner pick per match.

export type Round = 'r32' | 'r16' | 'qf' | 'sf' | 'final' | 'third';

export const ROUND_SIZES: Record<Round, number> = {
  r32: 16, r16: 8, qf: 4, sf: 2, final: 1, third: 1,
};

export const ROUND_ORDER: Round[] = ['r32', 'r16', 'qf', 'sf', 'final', 'third'];

// Points per round. Correct pick + bonus if the picked team was an underdog
// (implied probability < 0.45) at the time the bracket locked.
export const POINTS: Record<Round, { correct: number; upset_bonus: number }> = {
  r32:   { correct: 5,  upset_bonus: 3  },
  r16:   { correct: 10, upset_bonus: 5  },
  qf:    { correct: 20, upset_bonus: 10 },
  sf:    { correct: 40, upset_bonus: 15 },
  final: { correct: 80, upset_bonus: 20 },
  third: { correct: 15, upset_bonus: 5  },
};

export const CHAMPION_BONUS = 50; // extra for correctly picking the Final winner

export const UPSET_THRESHOLD = 0.45; // implied prob below this = underdog

export interface TreeNode {
  slotId: string;
  round: Round;
  slotIndex: number;
}

export function slotId(round: Round, index: number): string {
  return `${round}_${index}`;
}

// All 32 nodes in render order.
export function allNodes(): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const round of ROUND_ORDER) {
    for (let i = 0; i < ROUND_SIZES[round]; i++) {
      nodes.push({ slotId: slotId(round, i), round, slotIndex: i });
    }
  }
  return nodes;
}

// Where does the WINNER of this node advance to? null for final/third.
export function forwardOf(id: string): { toSlotId: string; side: 'home' | 'away' } | null {
  const [round, idxStr] = id.split('_');
  const i = Number(idxStr);
  const side: 'home' | 'away' = i % 2 === 0 ? 'home' : 'away';
  switch (round as Round) {
    case 'r32': return { toSlotId: slotId('r16', Math.floor(i / 2)), side };
    case 'r16': return { toSlotId: slotId('qf', Math.floor(i / 2)), side };
    case 'qf':  return { toSlotId: slotId('sf', Math.floor(i / 2)), side };
    case 'sf':  return { toSlotId: slotId('final', 0), side: i === 0 ? 'home' : 'away' };
    default:    return null; // final, third
  }
}

// Where does the LOSER of this node go? Only SF losers feed the third-place play-off.
export function loserForwardOf(id: string): { toSlotId: string; side: 'home' | 'away' } | null {
  const [round, idxStr] = id.split('_');
  const i = Number(idxStr);
  if ((round as Round) === 'sf') {
    return { toSlotId: slotId('third', 0), side: i === 0 ? 'home' : 'away' };
  }
  return null;
}

// The two nodes whose winners feed this node. Empty for r32 (seeded teams).
export function feedersOf(id: string): string[] {
  const [round, idxStr] = id.split('_');
  const i = Number(idxStr);
  switch (round as Round) {
    case 'r16':   return [slotId('r32', 2 * i), slotId('r32', 2 * i + 1)];
    case 'qf':    return [slotId('r16', 2 * i), slotId('r16', 2 * i + 1)];
    case 'sf':    return [slotId('qf', 2 * i), slotId('qf', 2 * i + 1)];
    case 'final': return [slotId('sf', 0), slotId('sf', 1)];
    case 'third': return [slotId('sf', 0), slotId('sf', 1)]; // the SF losers
    default:      return []; // r32
  }
}

// Placeholder R32 seeds so the builder is playable before the real draw is known.
// Replace these with the actual qualified teams (from TxLINE) once the group stage ends.
export const PLACEHOLDER_TEAMS: string[] = [
  'Brazil', 'South Korea', 'France', 'Senegal', 'Argentina', 'Japan', 'Spain', 'Morocco',
  'England', 'Ecuador', 'Portugal', 'Mexico', 'Netherlands', 'USA', 'Germany', 'Australia',
  'Belgium', 'Nigeria', 'Italy', 'Canada', 'Croatia', 'Ghana', 'Uruguay', 'Saudi Arabia',
  'Colombia', 'Tunisia', 'Denmark', 'Egypt', 'Switzerland', 'Qatar', 'Mali', 'Norway',
];
