# BracketBoss — World Cup Tournament Bracket Challenge

Fill out your World Cup knockout bracket, then watch TxLINE auto-update results and rescore every bracket in your group in real time. Bold (upset) picks score more. Submitted to the **Superteam × TxODDS World Cup Hackathon** — Consumer & Fan Experiences track.

**Stack:** Cloudflare Workers + Cron Triggers + D1 (no container, no Claude API). Frontend served from `/public` via Workers static assets.

- **Live:** _add your deployed URL_
- **Demo video:** _add link_
- **TxLINE endpoints used:** knockout fixtures + `full_time` results (see `src/txline.ts`)

---

## How it works

- **Frontend** (`public/`): create/join a group, fill a 32-match bracket (picks propagate forward, downstream picks roll back when you change an earlier one), submit, and watch the live leaderboard.
- **Worker** (`src/worker.ts`): REST API under `/api/*` + a cron `scheduled` handler.
- **D1**: `groups`, `brackets`, `matches`, `meta` (see `schema.sql`). Match tree is seeded automatically on first request.
- **Scoring** (`src/scorer.ts`): r32 5 · r16 10 · qf 20 · sf 40 · final 80 (+50 champion) · third 15, each with an upset bonus when the picked team's implied probability was < 45% at lock time.
- **Lock**: the first knockout kickoff (via TxLINE, or `POST /api/lock`) freezes all submissions.

### TxLINE integration

`src/txline.ts` is **stubbed** — wire `pollKnockout()` to the real TxLINE endpoints once you have your API key and confirmed field names (https://txline.txodds.com/documentation/worldcup). Until then, drive results in the demo with `POST /api/mock-result`.

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

# 3) Set the secret (no real keys in any committed file)
wrangler secret put TXLINE_API_KEY

# 4) Run locally / deploy
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

> Note: the placeholder R32 teams in `src/bracketTree.ts` are stand-ins so the builder is playable now — replace them with the real qualified teams once the group stage ends.

## Known limitations (hackathon scope)

- TxLINE polling is stubbed; results are demo-driven until the API is wired.
- Live leaderboard uses 15s client polling; a per-group Durable Object (scaffolded but disabled in `wrangler.toml`) can push updates instantly later.
- No auth; identity is group code + name. Add a Solflare wallet-connect on submit to satisfy the Solana sign-up requirement.
