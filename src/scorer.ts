// BracketBoss — scoring. Bold correct picks score more than safe ones.
import { CHAMPION_BONUS, POINTS, Round, UPSET_THRESHOLD } from './bracketTree';
import { MatchRow } from './bracketEngine';
import { Picks } from './bracketEngine';

export interface ScoreResult {
  total: number;
  correctPicks: number;
  breakdown: Record<Round, number>;
}

type OddsSnapshot = Record<string, Record<string, number>>; // slotId -> team -> decimal odds

/**
 * Score one bracket against the current match results.
 * Upset bonus: awarded when the picked team's implied probability (1/decimalOdds)
 * was below UPSET_THRESHOLD at lock time, per the stored odds snapshot.
 */
export function scoreBracket(
  picks: Picks,
  odds: OddsSnapshot | null,
  matches: Record<string, MatchRow>,
): ScoreResult {
  const breakdown: Record<Round, number> = {
    r32: 0, r16: 0, qf: 0, sf: 0, final: 0, third: 0,
  };
  let total = 0;
  let correctPicks = 0;

  for (const [slotId, pick] of Object.entries(picks)) {
    const match = matches[slotId];
    if (!match || !match.result_winner) continue; // not played yet
    if (match.result_winner !== pick) continue;   // wrong

    const round = match.round as Round;
    let pts = POINTS[round].correct;

    // Upset bonus.
    const dec = odds?.[slotId]?.[pick];
    if (dec && 1 / dec < UPSET_THRESHOLD) {
      pts += POINTS[round].upset_bonus;
    }

    // Champion bonus for a correct Final winner.
    if (round === 'final') pts += CHAMPION_BONUS;

    breakdown[round] += pts;
    total += pts;
    correctPicks += 1;
  }

  return { total, correctPicks, breakdown };
}
