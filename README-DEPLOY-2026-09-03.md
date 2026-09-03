# Genre Report Network — 2026-09-03 build delivery

**What this is:** the five-genre buildout, staged for your gated deploy per the registry's
`genre_reports.network.deploy_path` ruling (attended sessions deliver to disk; you run the gate).

## Contents

- `genre-report-network-2026-09-03.tar.gz` — the full repo at commit `afbea2e`, git history included
- `deploy-2026-09-03.sh` — the gated deploy script (asks you to type `DEPLOY` before shipping)

## What's in the build

1. **15 new pages** — fantasy, romance, mystery, science-fiction, horror × (home, subscribe,
   `q4-2026` Issue-001 permalink placeholder). Quarterly masthead cadence
   (`genre_reports.network.cadence`), optional first-name field
   (`…subscribe_fields`), offer card unchanged targeting stevepieper.com
   (`…offer_card_destination`). All noindex until you call launch.
2. **Truthful fine print site-wide** (`…capi_disclosure`) — "never sold or shared" is gone
   everywhere; subscribe surfaces disclose hashed-email sharing with Meta and link /privacy/.
   Thriller's three pages patched for parity (fine print + first-name field).
3. **`/privacy/` and `/terms/`** — drafted for your copy approval; they ship in this deploy,
   so read them before typing DEPLOY. Both carry the Parker, CO address.
4. **Worker: click-through confirm/unsubscribe** (`…confirm_unsubscribe_semantics`) —
   a bare GET can no longer mutate state (link-scanner protection); the page's button POSTs.
   RFC 8058 one-click POST still answers 200 always. 16-check behavioral suite passed.
5. **Tier-correct DOI emails** — fixed a live bug: the confirmation email hardcoded
   "`{Genre} Monthly`" and "New issue on the 1st," so a fantasy subscriber would have gotten
   "Confirm your Fantasy Monthly subscription." Publication name and cadence now derive from
   the genre's tier in `config/genres.json`.
6. **`config/genres.json`** — six genres, 34 aliases, byte-matched to the DB spine you applied
   this morning. Deploying this is what clears the fantasy-subscribe 400.

## To deploy

    sh deploy-2026-09-03.sh

Prereq: wrangler auth on this machine (`npx wrangler@4 login` once, or CLOUDFLARE_API_TOKEN set).
The script unpacks the tarball, shows the manifest, and deploys only after you type `DEPLOY`.

## After deploying — 60-second verification

- https://reports.stevepieper.com/fantasy/ renders Fantasy Quarterly
- a test subscribe on /fantasy/subscribe/ returns "Check your inbox" (the 400 is gone)
- the DOI email says "Fantasy Quarterly" / "Published quarterly."
- its confirm link opens a page with a button (does not auto-confirm)
- /privacy/ and /terms/ render

## Not in this build (by design)

No broadcast sender (build authorized, arming separately gated — `…dormancy`), no issues,
no sends. Nothing here emails anyone except DOI confirmations, exactly as before.
