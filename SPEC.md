# BracketBoss - World Cup Tournament Bracket Challenge
## Build Spec for Claude Code

---

## What we're building

A social bracket prediction app where fans fill out their World Cup knockout stage bracket before it begins, then watch TxLINE auto-update results and eliminate picks in real time across every match. Friends compete on a shared leaderboard. Scoring rewards bold predictions (picking upsets scores more). No manual updates - ever.

Submitted to the **Superteam × TxODDS World Cup Hackathon** under the **Fan Experiences** track.

**Hackathon deadline:** July 19, 2026 (23:59 UTC)
**Required:** deployed app, demo video, public GitHub repo, working link for judges

---

## Architecture overview

```
TxLINE SSE Stream
       │
       ▼
Node.js Backend (Express)
  ├── Listens for full_time events on knockout matches
  ├── Propagates winners through bracket tree
  ├── Recalculates scores for all affected brackets
  ├── Broadcasts updates to connected clients via SSE
  └── REST API: bracket CRUD, leaderboard, match data
       │
       ▼
Frontend (vanilla JS + HTML)
  ├── Bracket builder UI (drag/tap to pick winners)
  ├── Live bracket tracker (picks struck through on elimination)
  ├── Group leaderboard
  └── Share flow
```

---

## Project structure

```
bracketboss/
├── backend/
│   ├── index.js              # Express server entry point
│   ├── txline.js             # TxLINE SSE client
│   ├── bracketEngine.js      # Bracket tree logic + result propagation
│   ├── scorer.js             # Points calculation per bracket
│   ├── broadcast.js          # SSE broadcaster to clients
│   └── routes/
│       ├── brackets.js       # POST /bracket, GET /bracket/:id
│       ├── groups.js         # POST /group, GET /group/:code
│       ├── leaderboard.js    # GET /leaderboard/:groupCode
│       └── matches.js        # GET /matches/knockout
├── frontend/
│   ├── index.html            # Landing + group creation/join
│   ├── bracket.html          # Bracket builder + live tracker
│   ├── leaderboard.html      # Group leaderboard
│   ├── app.js                # All frontend logic
│   └── styles.css
├── db/
│   ├── brackets.json         # All submitted brackets
│   ├── groups.json           # Group registry
│   └── matches.json          # Knockout fixture tree + results
├── .env.example
├── package.json
└── README.md
```

---

## Bracket structure

The 2026 World Cup has an expanded 48-team format with 32 teams advancing to the knockout stage. The knockout bracket has these rounds:

```
Round of 32  (16 matches)
Round of 16  (8 matches)
Quarter-finals (4 matches)
Semi-finals    (2 matches)
Third place play-off (1 match)
Final          (1 match)
─────────────────────────
Total: 32 knockout matches, 63 picks per bracket
```

Bracket tree data structure:

```js
// Each node in the bracket tree
{
  matchId: string,           // TxLINE match ID (null until match is scheduled)
  round: 'r32' | 'r16' | 'qf' | 'sf' | '3rd' | 'final',
  slotIndex: number,         // position in the round (0-indexed)
  homeTeamSlot: string,      // 'winner_of_r32_0' or team name once known
  awayTeamSlot: string,
  result: null | { winner: string, score: string },
  kickoff: null | ISO timestamp
}
```

Store the full bracket tree in `db/matches.json`. Seed it with the known Round of 32 matchups (these are determined from group stage results - TxLINE will provide them). Propagate winners forward as results come in.

---

## Backend - detailed spec

### TxLINE SSE client (`txline.js`)

- Connect to TxLINE SSE stream
- Listen for `full_time` events on knockout matches only
- On each `full_time`: extract winner, update `matches.json`, call `bracketEngine.propagate(matchId, winner)`, trigger scorer and broadcaster

### Bracket engine (`bracketEngine.js`)

Two functions:

**`propagate(matchId, winner)`**
- Find the match in the tree
- Update `result` field
- Find the next round match that takes the winner from this slot
- Update that match's `homeTeamSlot` or `awayTeamSlot` with the winner's name
- Save updated tree
- Return list of affected match slots (for scorer to know what to recalculate)

**`validateBracket(picks)`**
- Called when a user submits their bracket
- Checks all 63 picks are filled
- Checks picks are internally consistent (can't pick a team to win the final if you didn't pick them to win the semi)
- Returns `{ valid: boolean, errors: [] }`

### Scorer (`scorer.js`)

Points system - reward bold, correct picks more than safe, obvious ones:

```js
const POINTS = {
  r32:   { correct: 5,  upset_bonus: 3  },   // 8 pts max for a correct upset pick
  r16:   { correct: 10, upset_bonus: 5  },
  qf:    { correct: 20, upset_bonus: 10 },
  sf:    { correct: 40, upset_bonus: 15 },
  final: { correct: 80, upset_bonus: 20 },
  champion: { correct: 50 }                   // bonus for correct tournament winner
}
```

**Upset bonus:** awarded when the user correctly picked the team that TxLINE had as the underdog (implied probability < 45%) at the time the bracket was locked.

```js
function scoreOnePick(pick, result, matchOddsAtLockTime, round) {
  if (pick !== result.winner) return 0

  let points = POINTS[round].correct

  // Check if this was an upset pick
  const pickedTeamOdds = matchOddsAtLockTime[pick]   // decimal odds
  const pickedImplied  = 1 / pickedTeamOdds
  if (pickedImplied < 0.45) {
    points += POINTS[round].upset_bonus
  }

  return points
}
```

When a match result comes in: rescore every bracket in the group for that pick, update leaderboard.

### Routes

**`POST /bracket`**
Body: `{ groupCode, userName, picks: { [matchSlotId]: teamName } }`
- Validate picks via `bracketEngine.validateBracket()`
- Store odds snapshot at time of submission (for upset bonus calculation later)
- Return `{ bracketId, shareUrl }`
- Reject submissions after the first knockout match kicks off (bracket lock)

**`GET /bracket/:bracketId`**
Returns full bracket with current scores, eliminated picks highlighted.

**`POST /group`**
Creates a new group. Returns a 6-character invite code (e.g. `WC2026`).

**`GET /group/:code`**
Returns group metadata + list of members + submission status.

**`GET /leaderboard/:groupCode`**
Returns ranked list: `[{ userName, bracketId, totalPoints, correctPicks, rank }]`
Sorted by `totalPoints` descending. Include delta from last update.

**`GET /matches/knockout`**
Returns current state of the bracket tree - teams, results, upcoming kickoffs.

---

## Frontend - detailed spec

### Landing page (`index.html`)

- Headline: "Fill your bracket. TxLINE does the rest."
- Two CTAs:
  - "Create a group" → generates invite code, redirects to bracket builder
  - "Join a group" → text input for 6-character code, redirects to bracket builder
- Show a static preview of what the bracket looks like

### Bracket builder (`bracket.html`)

Pre-lock (before first knockout match kicks off):

- Visual bracket: all 32 knockout slots laid out left-to-right, Round of 32 → Final
- Teams displayed in each first-round slot (pulled from `GET /matches/knockout`)
- User clicks/taps a team to pick them as winner - their name propagates to the next round slot
- Picking the winner of a match clears the loser from all subsequent rounds
- "Submit bracket" button at top - disabled until all 63 picks are filled
- Validation errors shown inline (e.g. "You picked Brazil to reach the final but didn't pick them to win the semi")

Post-lock (after first knockout match kicks off):

- Same visual layout but picks are frozen
- As TxLINE results come in via SSE:
  - Correct picks: team name turns green
  - Eliminated teams: struck through in red, ghosted
  - Pending picks: normal styling
- Running score shown at top: "142 pts - 2nd in your group"
- "View leaderboard" button → `leaderboard.html`

### Leaderboard (`leaderboard.html`)

- Table: rank, name, points, correct picks, last updated
- Auto-refreshes via SSE when a new result comes in
- Highlight the current user's row
- Show point breakdown: how many points from each round

### Share flow

After submitting a bracket:
- Show shareable link: `bracketboss.xyz/bracket/BRACKET_ID`
- Pre-composed tweet: "I've filled my #WorldCup2026 bracket on BracketBoss - think I know who's winning it 🏆 [link]"
- The public bracket URL shows a read-only view of the bracket - great for judges to verify it works

---

## Visual design

The bracket layout is the most important UI element - it needs to be clear and scannable on both desktop and mobile.

**Desktop:** horizontal flow left to right (R32 → Final). Each round is a column. Teams stacked vertically. Connector lines between rounds drawn with SVG.

**Mobile:** vertical scrollable layout. Each round is a horizontal row of match cards. User scrolls down through the rounds.

```
Round colours:
- R32:   #F1EFE8 (light grey)
- R16:   #EAF3DE (light green)
- QF:    #EEEDFE (light purple)
- SF:    #FAEEDA (light amber)
- Final: #EF9F27 (gold accent)

Pick states:
- Unpicked:   border: 1px dashed var(--color-border-secondary)
- Picked:     border: 1.5px solid var(--color-border-primary); font-weight: 500
- Correct:    background: #EAF3DE; color: #3B6D11; border-color: #3B6D11
- Eliminated: color: #B0A99E; text-decoration: line-through
- Pending:    normal styling, awaiting result
```

Use SVG connector lines between rounds. Draw them with JS after the bracket renders.

---

## Deployment

- **Backend:** Railway or Fly.io - persistent process for SSE connection
- **Frontend:** Vercel or Netlify
- Both must be publicly accessible. The public bracket share URL is important - judges will use it.

---

## Environment variables (`.env`)

```
TXLINE_API_KEY=your_txline_key
TXLINE_SSE_URL=https://txline.txodds.com/stream
TXLINE_BASE_URL=https://txline.txodds.com
PORT=3001
```

---

## Demo video plan (max 5 minutes)

1. **0:00-0:30** - Open landing page. Create a group. Get the invite code.
2. **0:30-1:30** - Fill out the bracket on the builder. Show the pick propagation working - click a team in R32, their name appears in R16. Fill all 63 picks. Hit Submit.
3. **1:30-2:00** - Open a second browser tab. Join the same group with a different name. Submit a different bracket.
4. **2:00-3:00** - Show the leaderboard. Then simulate a match result firing (add a `/mock-result` endpoint). Watch the bracket update live: correct picks go green, eliminated teams get struck through. Show the leaderboard updating in real time.
5. **3:00-3:30** - Show the public bracket share URL. Open it in a new tab. Confirm it's a clean read-only view.
6. **3:30-4:00** - Show the upset bonus in action - a correctly picked underdog showing higher points than a correctly picked favourite.
7. **4:00-4:30** - Pull up `bracketEngine.js` briefly. Show the propagation logic - clean, readable.
8. **4:30-5:00** - Wrap: "Fill once. Follow all 32 knockout matches automatically. Compete with friends. Zero admin."

---

## Submission checklist

- [ ] Bracket builder working with pick propagation
- [ ] Bracket validation (consistency check) working
- [ ] Group creation + join via invite code working
- [ ] Bracket lock triggers correctly at first knockout kickoff
- [ ] TxLINE results auto-update bracket + scores
- [ ] Leaderboard updating in real time
- [ ] Upset bonus scoring working
- [ ] Public share URL for each bracket
- [ ] Mobile layout usable
- [ ] `/mock-result` endpoint for demo
- [ ] GitHub repo public with README
- [ ] Demo video uploaded
- [ ] TxLINE endpoints listed in submission form
- [ ] API feedback prepared

---

## TxLINE resources

- Quickstart: https://txline.txodds.com/documentation/quickstart
- World Cup docs: https://txline.txodds.com/documentation/worldcup
- Support: Discord and Telegram
- Data fees waived until July 19, 2026

---

## Key decisions / notes for Claude Code

- **Seed `matches.json` with the bracket tree structure first** - the tree shape (which slot feeds into which) is fixed by tournament rules regardless of which teams are in it. Build the tree structure with placeholder team names and wire up the propagation logic before TxLINE is integrated. Then slot in real teams once the group stage completes.
- **Bracket lock timing is critical** - lock all submissions the moment the first knockout match kicks off. Use the TxLINE `kickoff` event to trigger this. Store the lock timestamp in `db/matches.json`. Reject any `POST /bracket` after this time.
- **Store odds at submission time** for the upset bonus. When a user submits their bracket, snapshot the current TxLINE odds for every knockout match that has been scheduled. Store this in the bracket record. Used later to determine whether a correct pick was an upset.
- **Pick propagation must handle rollback** - if a user changes a pick in R32, clear all downstream picks for that side of the bracket before applying the new pick. Otherwise you get impossible brackets (Team A in QF but Team B in SF on the same path).
- **SVG connector lines** are the tricky UI part. Draw them with JS after the bracket renders by measuring element positions and drawing `<line>` elements. Consider using a simple library like `leader-line` (available on cdnjs) rather than hand-rolling this.
- **Add `/mock-result` endpoint** - takes `{ matchSlotId, winner, score }` and fires as if TxLINE sent the full_time event. Essential for the demo video since you can't control when real matches happen.
- **Mobile layout:** don't try to fit the full horizontal bracket on mobile. Use a round-by-round vertical scroll instead. Each round is a labelled section. It's less visually impressive but actually usable on a phone, which is where most fans will be.
- **Flat file DB** is fine for the hackathon - with max 3 members per team and a 25-day tournament window, `brackets.json` won't exceed a few hundred KB.
- **The public share URL is important for judges** - make sure `GET /bracket/:bracketId` renders a clean, read-only HTML view (not just JSON). Judges will click this link. It should look good.
