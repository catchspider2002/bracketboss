# BracketBoss - Cloudflare Deployment

**Track:** Consumer & Fan Experiences · **Subdomain:** `bracketboss.<domain>`
**Build spec:** see `SPEC.md`. Read `../CLOUDFLARE-HANDOFF.md` first.

## Shape

A social bracket app with real user data (brackets, groups, leaderboards). The only live input is `full_time` on **knockout matches** - just 32 matches across the tournament, all at scheduled times. That's sparse and predictable, so you don't need an always-on SSE Container: a **Worker Cron** that polls knockout fixture status handles it. This is the most data-heavy of the Fan apps, so **D1 is the right store** (not flat files).

## Component mapping

| Spec component | Cloudflare |
|---|---|
| `txline.js` listen for `full_time` on knockout matches | **Worker Cron Trigger** polling knockout fixture status (sparse/scheduled - no Container needed). *Option B: Container SSE if you want instant updates.* |
| `bracketEngine.js` (propagate winners, validate brackets) | Worker logic module - **keep clean, judging centrepiece** |
| `scorer.js` (points + upset bonus) | Worker logic; rescore affected brackets on each result |
| `broadcast.js` live leaderboard/bracket updates | **Durable Object** per group (SSE/WebSocket push) - or clients poll `/leaderboard` |
| `db/brackets.json`, `groups.json`, `matches.json` | **D1** tables `brackets`, `groups`, `matches` (real relational user data) |
| Routes: `POST /bracket`, `GET /bracket/:id`, `POST /group`, `GET /group/:code`, `/leaderboard/:code`, `/matches/knockout` | Worker fetch handler |
| Bracket lock at first knockout kickoff | cron detects kickoff → set lock timestamp in D1; reject later `POST /bracket` |
| `frontend/` (builder, live tracker, leaderboard, SVG connectors) | **Cloudflare Pages** |
| `GET /bracket/:id` public read-only HTML view | Worker-rendered HTML (judges click this) |
| `POST /mock-result` (demo) | Worker route firing a synthetic `full_time` |

**Flow:** cron poll detects a knockout `full_time` → `bracketEngine.propagate` updates the D1 tree → `scorer` rescensores affected brackets → group Durable Object pushes the new leaderboard (or clients poll).

## Bindings (`wrangler.toml`)

```toml
name = "bracketboss"
main = "src/worker.ts"
compatibility_date = "2026-01-01"

[triggers]
crons = ["* * * * *"]   # poll knockout fixtures for kickoff (lock) + full_time (result)

[[d1_databases]]
binding = "DB"
database_name = "bracketboss"
database_id = "<wrangler d1 create bracketboss>"

[[durable_objects.bindings]]
name = "GROUP_ROOM"
class_name = "GroupRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GroupRoom"]
```

Secrets: `TXLINE_API_KEY` only (no Claude API).

## Scoring (from spec)

```
r32 5 (+3 upset) · r16 10 (+5) · qf 20 (+10) · sf 40 (+15) · final 80 (+20) · champion +50
upset bonus when picked team implied prob < 45% at bracket-lock time
```

## Deploy

1. `wrangler d1 create bracketboss` + schema (seed `matches` with the fixed knockout tree shape).
2. `wrangler deploy` (Worker + cron + D1 + DO).
3. `wrangler pages deploy frontend` → `bracketboss.<domain>`.
4. Verify the public `GET /bracket/:id` read-only view renders cleanly - judges use it.

## Notes

- **Snapshot odds at submission time** into the bracket's D1 row - needed later for upset-bonus scoring.
- **Pick propagation must roll back downstream picks** when an earlier pick changes, or you get impossible brackets.
- Mobile: round-by-round vertical scroll, not the full horizontal bracket.
- Group invite code (6 chars) is the social primitive. Optional Google sign-in (`GOOGLE_CLIENT_ID`) adds cross-device sync without gating play; the Solana tie-in is data provenance via TxLINE's on-chain audit trail, not user wallets.
