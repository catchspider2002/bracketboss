# BracketBoss - World Cup Tournament Bracket Challenge

Fill out your World Cup knockout bracket, then watch TxLINE auto-update results and rescore every bracket in your group in real time. Bold (upset) picks score more. Submitted to the **Superteam × TxODDS World Cup Hackathon** - Consumer & Fan Experiences track.

**Stack:** Cloudflare Workers + Cron Triggers + D1 (no container, no Claude API). Frontend served from `/public` via Workers static assets.

- **Live:** https://bracketboss.catchspider2002.workers.dev
- **GitHub:** https://github.com/catchspider2002/bracketboss
- **Demo video:** _add link_
- **TxLINE endpoints used:** `POST /auth/guest/start`, `GET /api/fixtures/snapshot`, `GET /api/scores/snapshot/{fixtureId}` (see `src/txline.ts`)

---

## How it works

- **Frontend** (`public/`): create/join a group, fill a 32-match bracket (picks propagate forward, downstream picks roll back when you change an earlier one), submit, and watch the live leaderboard.
- **Worker** (`src/worker.ts`): REST API under `/api/*` + a cron `scheduled` handler.
- **D1**: `groups`, `brackets`, `matches`, `meta` (see `schema.sql`). Match tree is seeded automatically on first request.
- **Scoring** (`src/scorer.ts`): r32 5 · r16 10 · qf 20 · sf 40 · final 80 (+50 champion) · third 15, each with an upset bonus when the picked team's implied probability was < 45% at lock time.
- **Per-match locking**: brackets stay open during the tournament. Any match that has finished is pre-filled with the real winner in the builder and can't be changed - and the server forces it on submit, so you can't pick a wrong result for a played game. (`POST /api/lock` still exists to freeze all submissions manually, e.g. at tournament end.)

### TxLINE integration (wired)

`src/txline.ts` calls the real TxLINE API: it fetches a guest JWT (cached in D1, auto-refreshed), then reads `/api/fixtures/snapshot` and `/api/scores/snapshot/{fixtureId}` with both required headers (`Authorization: Bearer <jwt>` + `X-Api-Token: <TXLINE_API_KEY>`). The cron resolves each finished knockout match to a winner (handles extra time + penalties) and propagates it.

**It only acts on slots you've mapped to a fixture.** Because the knockout draw isn't known until the group stage ends, you map fixtures → bracket slots via the admin endpoints below. Until then the cron is a safe no-op, and you can still demo with `POST /api/mock-result`.

---

## Setup & deploy

```bash
npm install
wrangler login                       # your Cloudflare account

# 1) Create the D1 database, then paste the printed database_id into wrangler.toml
wrangler d1 create bracketboss

# 2) Create tables (local for dev, --remote for production)
npm run db:init                      # local
npm run db:init:remote               # production

# 2b) If your DB was created before the owner column, run the migration once
#     (the `wallet` column is reused to store the signed-in Google account id):
wrangler d1 execute bracketboss --remote --file ./migrations/0001_add_wallet.sql

# 3) Set the secrets (no real keys in any committed file)
wrangler secret put TXLINE_API_KEY      # your txoracle_api_... token
wrangler secret put ADMIN_KEY           # any long random string (gates /api/admin/*)

# 4) (Optional) Enable "Sign in with Google" for cross-device sync:
#    Create a Web OAuth Client ID at https://console.cloud.google.com (Credentials),
#    add your deployed origin under "Authorized JavaScript origins", then set it in
#    wrangler.toml ([vars] GOOGLE_CLIENT_ID = "..."). The client id is public.
#    Leave it blank to hide the sign-in button - the app works fully without it.

# 5) Run locally / deploy
npm run dev                          # http://localhost:8787
npm run deploy
```

Then attach the custom domain `bracketboss.<your-domain>` to the Worker in the Cloudflare dashboard (or via `wrangler`).

### Local secrets

Copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in `TXLINE_API_KEY` for `wrangler dev`. Production uses `wrangler secret put`, never a committed file.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/group` | create a group → `{ code }` |
| GET | `/api/group/:code` | group + members |
| GET | `/api/matches/knockout` | bracket tree + results + lock state |
| POST | `/api/bracket` | submit `{ groupCode, userName, picks, odds? }` |
| GET | `/api/bracket/:id` | one bracket + computed score + results |
| GET | `/api/leaderboard/:code` | ranked group leaderboard |
| POST | `/api/mock-result` | demo: `{ slotId, winner, score }` → propagate + rescore |
| POST | `/api/lock` | manually lock submissions |

### Demo flow (no live match needed)

1. Create a group on the home page, build + submit a bracket, open a second tab and submit another under the same code.
2. Lock + fire a result: `curl -X POST .../api/mock-result -H 'content-type: application/json' -d '{"slotId":"r32_0","winner":"Brazil","score":"2-1"}'`
3. Watch the leaderboard update and the bracket view mark picks correct/eliminated.

> Note: the placeholder R32 teams in `src/bracketTree.ts` are only stand-ins for first-boot. Now that the group stage is over, replace them with the real draw using the one-shot **auto-seed** endpoint described in "Going live with real results" below.

## Going live with real results

The group stage is over, so the Round-of-32 is set. One command does everything - the **auto-seed** endpoint knows the official 2026 R32 draw (`src/bracket2026.ts`) and matches each TxLINE fixture to its **correct bracket slot by team name**, so the pairings are right automatically (no kickoff-order guessing, no manual fixture lists). It also attaches the fixture id + kickoff to wire the cron, marks any already-finished match immediately, and fills any slot whose live fixture hasn't appeared yet with the real team names from the draw. Uses the `ADMIN_KEY` in an `X-Admin-Key` header.

```bash
BASE=https://bracketboss.<sub>.workers.dev
KEY=your_admin_key

# 1) PREVIEW (no writes). Check `assignments` (each slot's teams), `withFixture` (how many slots
#    have a live TxLINE fixture), `missingFixtures`, and `unmatchedFixtures` (name-alias misses):
curl -H "X-Admin-Key: $KEY" "$BASE/api/admin/auto-seed-r32"

# 2) APPLY - that's it, no fixtureIds needed:
curl -X POST "$BASE/api/admin/auto-seed-r32" -H "X-Admin-Key: $KEY" \
  -H 'content-type: application/json' -d '{"apply":true}'
```

The builder now shows the real teams in their true positions, finished matches are scored on the spot (the response lists them in `results`), and the every-minute cron posts later winners automatically (extra time + penalties handled) and propagates teams forward. If a fixture's teams don't match the draw, it shows up in `unmatchedFixtures` - add the name variant to `ALIASES` in `src/bracket2026.ts`.

A match that finished early in the round can drop out of the TxLINE fixtures snapshot before you seed (so there's no live fixture and the cron can't post it). For those, add the final score to the `result` field of that slot in `R32_DRAW` (`src/bracket2026.ts`) - auto-seed applies it as a fallback so the match is scored and locked. (Or set it ad-hoc with `POST /api/mock-result {slotId,winner,score}`.) Slots that are still genuinely unresolved appear in `missingFixtures`.

> The slot → FIFA-match-number map and the R32 teams in `src/bracket2026.ts` come from the official tournament regulations and the published bracket (group stage complete). If you re-run this for a different tournament, update that file.

<details><summary>Manual alternative (the original per-slot endpoints)</summary>

```bash
# See the fixtures TxLINE has:
curl -H "X-Admin-Key: $KEY" "$BASE/api/admin/fixtures"
# Seed 32 team names (order = r32_0.home, r32_0.away, r32_1.home, ...):
curl -X POST "$BASE/api/admin/seed-teams" -H "X-Admin-Key: $KEY" -H 'content-type: application/json' \
  -d '{"teams":["TeamA","TeamB", "...32 names..."]}'
# Map each slot to its fixture (home/away must match TxLINE Participant1/Participant2):
curl -X POST "$BASE/api/admin/map" -H "X-Admin-Key: $KEY" -H 'content-type: application/json' \
  -d '{"slotId":"r32_0","fixtureId":123456,"home":"TeamA","away":"TeamB"}'
```
</details>

## Known limitations (hackathon scope)

- TxLINE polling is stubbed; results are demo-driven until the API is wired.
- Live leaderboard uses 15s client polling; a per-group Durable Object (scaffolded but disabled in `wrangler.toml`) can push updates instantly later.
- Identity is group code + name. The home page remembers your groups/brackets in `localStorage`; **optionally** signing in with Google keys submitted brackets to your account so they also recall across devices via `POST /api/my` (the server verifies the Google ID token, so it's not trust-on-submit). No account is required to play - sign-in is pure progressive enhancement, which keeps the experience friendly for mainstream, non-technical fans. The Solana angle here is data provenance: every result and odds value comes from TxLINE's on-chain, tamper-evident audit trail.
