# BracketBoss — Submission Checklist

Track: **Consumer & Fan Experiences** (Superteam × TxODDS World Cup Hackathon)
Live: https://bracketboss.catchspider2002.workers.dev · Repo: https://github.com/catchspider2002/bracketboss

## ✅ Done

- [x] Backend: D1 schema + auto-seeded 32-match knockout tree
- [x] Bracket engine: validation + winner propagation (with rollback)
- [x] Scoring: round points + upset bonus + champion bonus
- [x] Frontend: create/join group, bracket builder (pick propagation), live tracker, leaderboard
- [x] Shareable read-only bracket URLs
- [x] "Your stuff" memory via localStorage (groups + brackets persist on home)
- [x] Optional "Sign in with Google" (server-verified ID token) for cross-device sync — no account required to play
- [x] Cross-device recall: brackets keyed to the Google account via `POST /api/my`
- [x] Removed wallet/Solana-wallet login (not a hackathon requirement; friction for mainstream fans)
- [x] TxLINE wired: guest-JWT auth (cached), `/api/fixtures/snapshot`, `/api/scores/snapshot/{id}`
- [x] Cron: locks on first kickoff + applies winners (ET/penalties handled) for mapped fixtures
- [x] Admin endpoints: list fixtures, seed real R32 draw, map fixture → slot
- [x] One-shot `auto-seed-r32`: official 2026 R32 draw (`bracket2026.ts`) → matches fixtures to correct slots by team name, attaches fixture+kickoff, auto-marks finished matches (preview + apply)
- [x] Per-match locking: completed matches pre-selected + non-editable in builder and forced server-side on submit (no more global lock-at-kickoff; brackets stay open)
- [x] Demo driver: `POST /api/mock-result`
- [x] Deployed to Cloudflare Workers + D1; secrets via `wrangler secret`
- [x] README with deploy + go-live instructions
- [x] Solana free-tier subscription activated (TxLINE token)

## ⏳ Before submitting

- [ ] **Record demo video** (≤5 min) — follow the shot list in README; use `mock-result` to show live scoring
- [ ] **Add the demo video link** to README (and the submission form)
- [ ] **Push final code to GitHub** — confirm latest commit (txline + Google auth + admin); verify `.dev.vars` is NOT committed
- [ ] (Optional) Create a Google OAuth Client ID and set `GOOGLE_CLIENT_ID` in wrangler.toml to enable cross-device sync
- [ ] **Verify TxLINE end-to-end** — set `ADMIN_KEY`, then `GET /api/admin/fixtures` returns live fixtures
- [ ] **Fill submission form**: live URL, GitHub URL, video URL, TxLINE endpoints used, API feedback
- [ ] Attach custom domain `bracketboss.<domain>` (optional, nicer than `workers.dev`)

## 🔜 Go fully live now (group stage is over — R32 is set)

- [ ] `GET /api/admin/auto-seed-r32` to preview (official draw → correct slots by team name)
- [ ] Check `withFixture`/`missingFixtures`/`unmatchedFixtures`, then `POST {apply:true}` (no fixtureIds needed)
- [ ] Enter any missing/aged-out result via `/api/mock-result`; confirm builder shows real teams + cron posts winners

## 💡 Optional polish / known limitations

- [ ] Live leaderboard push via the scaffolded `GroupRoom` Durable Object (currently 15s polling)
