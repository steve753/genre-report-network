---
name: genre-report-network
description: Produce, verify, publish, and distribute monthly per-genre book-industry reports for the Genre Report Network (reports.stevepieper.com) — Polymath Consulting & Publishing. Use for any genre-report work — monthly production runs, single-issue builds, new-genre onboarding, subscriber/DOI operations, template or Worker changes, and email sends. Covers the researcher → adversary → publisher pipeline, all infrastructure endpoints, and every binding editorial and licensing policy.
---

# Genre Report Network — Operations Skill

Monthly, in-depth, per-genre book-industry reports for working authors,
published at `reports.stevepieper.com/{genre}/`, funded as audience
development for Polymath's Direct Sales Dominance program. Design doc of
record: "Genre Report Network — Development Path and Feasibility Review"
(Cowork claude-docs working folder). This skill is self-contained: a fresh
session can operate from this file alone.

## Infrastructure map (no secret values here — names only)

| Piece | Where | Notes |
|---|---|---|
| Site | `reports.stevepieper.com/{genre}/` | genre home serves latest issue, `rel=canonical` → dated permalink `/{genre}/{mmm}-{yyyy}/`; vanity `{genre}.stevepieper.com` 301s to genre home |
| Repo | `github.com/steve753/genre-report-network` (public) | `public/` static pages, `src/index.js` Worker, `config/genres.json` genre slugs+aliases (Worker reads it for vanity redirects AND subscribe validation) |
| Deploy | push to `main` → GitHub Actions → wrangler | wrangler version is PINNED (≥4.86) in the workflow — the action's default is too old for current compatibility dates. If git push is blocked by the session's git proxy, fall back to GitHub's web upload (`/upload/main/<dir>`) via the user's Chrome; verify each commit landed |
| Worker | Cloudflare Worker `genre-reports`, account `a3aa29700c8ce88b6777e2b251f0f91b` | `run_worker_first = true` (vanity redirects must run before asset serving). Routes: `reports.stevepieper.com/*` + `*.stevepieper.com/*`. Unknown hostnames pass through untouched |
| Worker secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `POSTMARK_TOKEN`, `DOI_SIGNING_SECRET`, `META_PIXEL_ID`, `META_CAPI_TOKEN` | GOTCHA: secrets added in the Cloudflare dashboard create a NEW VERSION that does not carry traffic until promoted (Deployments → ⋯ → Promote version). Promote BEFORE the next wrangler deploy or the deploy builds without them |
| Registry DB | Supabase project `mybnrqouoqavmbaywzoa`, schema `genre_reports` | tables: genres, subscribers, issues, suggestions. PostgREST needs `Accept-Profile`/`Content-Profile: genre_reports` headers; custom schemas need BOTH the dashboard "Exposed schemas" toggle AND explicit service_role grants |
| DOI API | Worker: `POST /api/subscribe`, `GET /api/confirm`, `GET /api/unsubscribe` | double opt-in; Supabase owns all lists; confirmation email = HtmlBody (branded) + TextBody, From `Steve Pieper <reports@stevepieper.com>`, Postmark transactional stream `outbound` |
| Broadcast email | Postmark broadcast stream `genre-reports` | confirmed subscribers only. HARD GATE: no batch send until the business postal address is in the footer (CAN-SPAM) — Steve supplies it. Build ALL links from config, never from request URLs |
| Meta CAPI | Worker fires `Lead` (subscribe) and `CompleteRegistration` (confirm) server-side | Polymath pixel (secrets in Cloudflare). event_id = `{doi_token}-lead` / `-confirm` for browser-pixel dedup. LOGGING CONVENTION (§4.1, applies to every newsletter flow): one line per attempt — `meta_capi_sent <event> pixel_id <id> status <code>` / `meta_capi_error …` / `meta_capi_skipped_no_secrets <event>`. Pixel ID always logged, token never |
| Data credentials | Supabase Vault: `rainforest_api_key`, `nyt_api_key`, `postmark_server_token`, `github_pat` | Rainforest = Amazon harvest (Mystery/Thriller bestsellers node 10457 etc.); NYT Books API = list data |
| K-lytics ingestion | Dropbox: `Polymath C&P Team Folder/Genre Report Network/data/k-lytics/{YYYY-MM}/` | manual drop only — no API exists, no scraping. Report publishes the LAST day of each month; production on the 1st uses yesterday's drop. Folder named for the report's data month |

## The pipeline (per issue)

**1. Data pull (scripts, not agents).** NYT lists via Books API; Rainforest
bestseller + new-release description harvest per genre; latest K-lytics
export from the Dropbox drop-folder. One versioned data pack per genre plus
a shared cross-genre pack. A failed pull aborts the genre, never the batch.

**2. Researcher** (`genre-report-researcher`). Five most consequential
stories for working authors in the genre (~200 words each, inline
citations); hooks-and-tropes strictly from the harvested descriptions; data
sections computed ONLY from the data pack, charts as inline SVG with
source-and-date captions. Deliver fewer than five stories with a
reader-facing note rather than manufacturing significance. Output: report
markdown with front matter (genre, month, story list, email teaser bullets,
production notes) + machine-readable citations manifest.

**Hard rules — evidence must be visible IN the customer-facing report:**
(a) no claim without an inline hyperlinked citation; (b) no data value not
traceable to the data pack, source and as-of date printed on the page;
(c) estimates attributed in visible prose; (d) unresolved uncertainty
stated, not smoothed; (e) NEVER qualify an assertion as "honest" ("one
honest caveat", "to be honest", "frankly") — honesty is the publication's
premise, so qualifying one claim casts doubt on the rest; (f) K-lytics
material only per the K-lytics policy below.

**3. Adversary** (`genre-report-adversary`). Assume the draft is wrong.
Checks: (1) citation integrity — fetch ≥60% of cited URLs incl. every
quantitative one, verify the source says what the report claims;
(2) reader-visible compliance with the hard rules (manifest-only compliance
= severity-1); (3) recompute every figure from the data pack; (4) estimates
presented as fact = severity-1; (5) cut padding — a shorter issue outranks
a padded one; (6) inference audit; (7) repetition vs prior three issues;
(8) tone — hype, superlatives, urgency, honesty-qualifiers (severity-2);
(9) K-lytics compliance (see policy; member-test failures and reproduced
charts/series = severity-1; missing affiliate disclosure = severity-1).
Verdicts: RELEASE / REVISE / REJECT; max two REVISE rounds, then
RELEASE-WITH-NOTES or REJECT; zero severity-1s to release. Never publish a
placeholder.

**4. Publisher** (`genre-site-publisher`). Deterministic; never alters
report text. Reference implementation: the live thriller pages
(`public/thriller/`). Template (Dangle-derived construct):
- Head: favicon links (`/favicon.svg`, `/favicon.ico`,
  `/apple-touch-icon.png` — files once at site root); meta description;
  `noindex` ONLY while the genre is pre-launch (per-genre flag); canonical:
  genre home → dated permalink, permalink → itself.
- Fixed utility bar hidden on load, slides in when the masthead leaves the
  viewport (IntersectionObserver): wordmark, in-issue search, archive
  dropdown (update options on BOTH genre home and new permalink),
  Subscribe.
- Dark masthead: spaced-caps wordmark, italic tagline, email capture →
  `POST /api/subscribe {genre, email, consent_source:'{genre}-issue-NNN'}`,
  cadence line "Every claim cited, every figure sourced. New issue on the
  1st." Subscribe buttons jump INSTANTLY to page top and focus the email
  field.
- Body: "from the desk of" line, uppercase kicker, crimson section-prefix
  headers, inline citations, captioned data figures.
- Offer card after story two: kicker FROM POLYMATH, crimson left border,
  hook of record — "Author-Direct Sales: The guy who told you to wait just
  spent $197k proving himself wrong." — Learn More → Direct Sales Dominance
  landing page, plus "Testing details in the disclosure at the bottom of
  this page."
- Bottom CTA: "Go deeper, stay informed, sell more copies:" — Subscribe
  (solid crimson) + "Get help with Direct Sales" (bg `#3d0000`, gold
  border).
- Footer: copyright/contact; NYT + Rainforest attribution; the
  testing-disclosure `<details>` — summary "About the $197,000 in testing",
  lead sentence and nine bullets EXACTLY per design doc §2.14 as amended
  2026-08-14 ("historically proven offers", "retail site product page",
  "privately owned web store"); permalink line.
- Per-genre subscribe landing page `/{genre}/subscribe/`: masthead-only, no
  utility bar/footer, pitch bullets, "For our fellow skeptics: read the
  current issue first →", CAN-SPAM fine print, UTM params appended into
  `consent_source '{genre}-subscribe-page'`.

Post-publish smoke test: fetch genre home, new permalink, vanity host
(verify a TRUE 301); verify title/month/links, offer card + landing link,
current disclosure wording, favicon reachable, canonical tags, robots state
matches launch flag; prior permalink still resolves byte-identical. Update
the Supabase issues row.

**5. Email.** Per-subscriber notification (first name, four teaser bullets,
permalink) as HtmlBody + TextBody via broadcast stream `genre-reports`.
CAN-SPAM postal-address gate applies.

**6. Telemetry.** Tokens, searches, rounds, verdicts, cost per issue into
the issues table; monthly ops summary includes `meta_capi_sent` vs
`meta_capi_error` counts from Worker logs.

Failure policy: single-genre failures never block the batch; anything
unpublished by EOD on the 2nd escalates to Steve with the adversary's last
verdict.

## New-genre onboarding (`genre-onboarding`)

Match detected genre phrase against the registry incl. aliases and fuzzy
matches; below-threshold confidence → ask a human, never create a
near-duplicate. Existing genre → subscribe client (record consent
provenance), send latest issue. New genre → four-gate rubric (ratified
2026-08-13): distinctness (no alias match, <70% coverage overlap); demand
(1 paying client OR 10+ suggestions/90 days OR Steve's call); coverage
viability (90-day dry run: 5+ stories = monthly, 3–4 = quarterly, <3 =
decline); taxonomy (slug policy; slug pending until inaugural issue). On
approval: registry row + `config/genres.json` entry + subscribe landing
page + client as subscriber #1 + inaugural "State of the Genre" issue
(trailing-90-day scope) through the full pipeline + verify all four URLs
serve. Idempotent and logged. Suggesters are invited, never auto-subscribed.

## Binding policies

**K-lytics (B6 policy — ratified by Steve 2026-08-14, grounded in Alex's
permission email of the same date; archive PDF lives in the Dropbox
k-lytics folder root once the exchange concludes):**
1. Attribute "K-lytics" by name with report month on every derived
   statement.
2. Without asking: trend-level observations (the kind K-lytics promotes in
   its own announcement emails) and selected individual figures — AT MOST
   THREE discrete K-lytics figures per issue.
3. Never: reproduce a chart; redistribute a report; print a table/series or
   enough figures to reconstruct one; the report's core analysis.
4. The member test governs, applied independently by researcher AND
   adversary: would a paying K-lytics member be annoyed to find this free?
   Plausibly yes → cut it or ask first.
5. Slide shares: case-by-case ask routed through Steve; log permission in
   the issues row.
6. Affiliate: where a citation invites the reader deeper, use Steve's
   member affiliate link WITH a visible affiliate-relationship disclosure
   on the page. Editorial decision precedes commission, always.
7. No scraping or automated access; manual Dropbox ingestion only.
8. When in doubt, ask K-lytics — the permission is relationship-based.
K-lytics is seasoning; the publication's own Rainforest-derived metrics are
the data spine and the differentiator.

**$197k disclosure (§2.14 as amended 2026-08-14):** header "About the
$197,000 in testing"; "$197,000 spent by Polymath Consulting & Publishing
over a seven-month period (January–July 2026) to characterize the relative
profitability of historically proven offers under the following advertising
conditions:" + nine bullets using "pointing directly to a retail site
product page" (traffic + interstitial-button variants) and "pointing to a
privately owned web store" (Purchase-event variants). Never edit this
wording without Steve's explicit instruction.

**Style:** never qualify any assertion as "honest" — anywhere in
publication copy.

**NYT:** attribute per API terms wherever NYT data appears.

**Launch state:** all pages carry `noindex` until Steve calls launch;
the offer-card Learn More URL is a placeholder (`stevepieper.com`) until
the real DSD landing page exists.

## Scheduling

Monthly production: cron on the 1st, 06:00 UTC (pre-production check
scheduled task exists at 13:00 UTC on the 1st; K-lytics drop-day reminder
fires month-end). A scheduled session should: read this skill, pull the
repo, run the pipeline for each active genre in `config/genres.json`,
and escalate per the failure policy. Steve = confirmed subscriber #1
(thriller) — the DOI loop and CAPI logging are live-verified as of
2026-08-14.
