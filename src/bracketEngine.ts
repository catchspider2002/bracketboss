// BracketBoss - bracket validation and result propagation.
import { allNodes, feedersOf, forwardOf, loserForwardOf, Round } from './bracketTree';

export type Picks = Record<string, string>; // slotId -> team name

/**
 * Validate a submitted bracket.
 * - Every one of the 32 match nodes must have a pick.
 * - Each pick must be internally consistent: for any round above R32, the picked
 *   winner must be one of the two teams the user advanced into that match
 *   (i.e. their own picks in the two feeder matches). The third-place node is
 *   filled by the SF losers, so its pick must be a SF participant that did NOT
 *   win its semi.
 */
export function validateBracket(picks: Picks): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodes = allNodes();

  for (const node of nodes) {
    const pick = picks[node.slotId];
    if (!pick) {
      errors.push(`Missing pick for ${node.slotId}`);
      continue;
    }
    const feeders = feedersOf(node.slotId);
    if (feeders.length === 0) continue; // r32: any seeded team is acceptable here

    if (node.round === 'third') {
      // Third place: participants are the two SF losers = (feeder participants) minus (SF winners).
      const semiLosers = feeders.map((f) => {
        const semiWinner = picks[f];
        const semiFeeders = feedersOf(f);
        const semiParticipants = semiFeeders.map((sf) => picks[sf]).filter(Boolean);
        return semiParticipants.find((t) => t !== semiWinner);
      }).filter(Boolean) as string[];
      if (!semiLosers.includes(pick)) {
        errors.push(`Third-place pick "${pick}" is not a losing semi-finalist`);
      }
      continue;
    }

    const advanced = feeders.map((f) => picks[f]).filter(Boolean);
    if (!advanced.includes(pick)) {
      errors.push(`Pick "${pick}" in ${node.slotId} wasn't advanced from the previous round`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Propagate a real result through the stored match tree.
 * Returns the slot ids that changed (so the caller can rescore).
 * `rows` is the current matches table keyed by slot_id; we mutate a plain object map.
 */
export function propagate(
  matches: Record<string, MatchRow>,
  slotId: string,
  winner: string,
  score: string,
): string[] {
  const changed: string[] = [];
  const node = matches[slotId];
  if (!node) return changed;

  node.result_winner = winner;
  node.result_score = score;
  changed.push(slotId);

  // Advance winner.
  const fwd = forwardOf(slotId);
  if (fwd && matches[fwd.toSlotId]) {
    const target = matches[fwd.toSlotId];
    if (fwd.side === 'home') target.home_slot = winner;
    else target.away_slot = winner;
    changed.push(fwd.toSlotId);
  }

  // Advance loser to third-place play-off if this was a semi-final.
  const loserFwd = loserForwardOf(slotId);
  if (loserFwd && matches[loserFwd.toSlotId]) {
    const loser = inferLoser(node, winner);
    if (loser) {
      const target = matches[loserFwd.toSlotId];
      if (loserFwd.side === 'home') target.home_slot = loser;
      else target.away_slot = loser;
      changed.push(loserFwd.toSlotId);
    }
  }

  return changed;
}

function inferLoser(node: MatchRow, winner: string): string | null {
  if (node.home_slot && node.home_slot === winner) return node.away_slot || null;
  if (node.away_slot && node.away_slot === winner) return node.home_slot || null;
  return null;
}

export interface MatchRow {
  slot_id: string;
  round: Round;
  slot_index: number;
  home_slot: string | null;
  away_slot: string | null;
  match_id: string | null;
  kickoff: string | null;
  result_winner: string | null;
  result_score: string | null;
}
