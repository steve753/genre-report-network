# API Production Runner — Runbook (DR-0168)

Unattended issue production: a GitHub Actions workflow invoking the Claude
Agent SDK on the Polymath Anthropic API account. Attended Cowork sessions
remain the path for inaugural issues; this runner owns RECURRING cycles only,
and owns nothing until it passes a thriller shakedown (DR-0168).

## What runs where

| Piece | Where | Gate |
|---|---|---|
| Data packs | Supabase Edge Function `genre-data-pull`, fired by pg_cron 05:30 UTC on the 1st (request ids logged to `genre_reports.runner_pull_log`) | none needed — read-only harvest |
| Issue production | `.github/workflows/produce-issue.yml` job `produce` (06:30 UTC on the 1st once armed) | none — it holds no write credential at all (contents:read; DB token only in the pre-seat prepare step); its built pages are review previews, and the only things that leave its machine are the review artifacts, of which `draft.md` + `summary.json` are the publish job's content inputs |
| Page build + deploy | job `publish`, bound to GitHub environment `production`: a fresh machine REBUILDS the pages deterministically from the approved draft with HEAD code and HEAD chrome, commits exactly those paths, deploys | **Steve's required-reviewer approval in GitHub** (DR-0158) |
| Draft row + publication record + notify | `runner/publish-issue.mjs` inside the `publish` job | runner token gate + write-lane Postgres gates (DR-0166) |
| Subscriber send | unchanged | **Steve's one-click approval email** (DR-0165) |

Two human clicks per issue, both Steve's: the GitHub deploy approval, then the
send approval. No other path exists.

## One-time setup (Steve, in order)

1. **Supabase Vault** (Project Settings → Vault): add `runner_db_token` (fresh
   random value), `data_pull_token` (the existing DATA_PULL_TOKEN value),
   `project_anon_key` (the anon key). Enable extensions `pg_cron` and `pg_net`.
2. **SQL migration**: run the runner migration file from Production
   Configuration in the SQL editor, then the companion `-VERIFY` file; paste
   back the verify output. The verify file confirms the K-lytics extract is
   NOT visible without the runner token.
3. **GitHub → Settings → Environments**: create environment `production`,
   add yourself as a required reviewer.
4. **GitHub → Settings → Branches**: confirm `main` has no protection rule
   that blocks a direct push from Actions (the publish job pushes the
   approved merge). If protection exists, tell the next session — the publish
   path then needs a PR + auto-merge variant.
5. **GitHub → Settings → Secrets and variables → Actions**:
   - Secrets: `ANTHROPIC_API_KEY` (Polymath Console account, Scale tier),
     `SUPABASE_ANON_KEY`, `RUNNER_DB_TOKEN` (same value as the Vault secret),
     `WRITE_LANE_URL` (the genre-write connector URL including its token).
     `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` already exist for deploy.
   - Variables: `SUPABASE_URL`, `MODEL_RESEARCH`, `MODEL_WRITER`,
     `MODEL_ADVERSARY`, `MODEL_MECHANICAL` (verify current model IDs in the
     Console model list; adversary must differ from writer — the runner
     refuses to start otherwise), `ROUNDS_MAX` (suggest 6),
     `SEAT_OUTPUT_TOKEN_CAP` (suggest 200000; a post-hoc guard — it aborts a
     run whose last seat overran, it cannot stop a seat mid-flight),
     `RUNNER_SCHEDULE_ENABLED` = `false` until the shakedown passes.
   A dispatch also offers `allow_stale_pack` for the deliberate case of
   producing on last month's data after a failed pull.
6. **K-lytics monthly load** (attended, when the report drops): the extract
   goes into the database as a data-pack row — paste template in
   `runner/sql/klytics-load-TEMPLATE.sql`, values filled in by the attended
   session before delivery. If no fresh row exists, the runner publishes
   without K-lytics and says so in production notes (ruled 2026-09-04).

## Shakedown (before the runner owns any cycle)

Run `Produce Issue` via workflow_dispatch with `genre: thriller` for the next
thriller month. The shakedown issue IS the runner's first production — its
failure costs a re-run, not a desk's debut. Review the artifacts (draft,
adversary reports, layout check, screenshots, summary.json) on the run page
before approving the `publish` job. Items the shakedown must confirm that could not be verified from the
authoring environment (its egress proxy blocks the npm registry for this
package):
- the `@anthropic-ai/claude-agent-sdk` install and its `query()` call shape
  (the resolved version is recorded in `summary.json` as `sdk_version`);
- that `usage.output_tokens` is per-seat, before trusting the seat cap;
- whether the SDK honors the `env` option passed to `query()` (the CONTROL is
  the workflow's per-step secret scoping either way — this is a belt);
- whether `allowedTools`/`disallowedTools` actually restrict a seat's tool
  set under `permissionMode: bypassPermissions` (the writer and layout seats
  are meant to have no shell and no web access);
- how the `production` environment gate behaves on a multi-leg publish matrix
  (one approval for all legs vs one per leg) — dispatch two genres once and
  write the observed behavior here;
- that the publish job's rebuild-from-draft produces byte-identical pages to
  the reviewed previews (compare the deployed page against the artifact
  screenshots).

After a clean end-to-end issue — pages live, row published, notify received,
send clicked — do two things: (a) generate `runner/package-lock.json` on any
machine with npm access (`cd runner && npm install`), commit it, and switch
both `npm install` workflow steps to `npm ci`; (b) flip
`RUNNER_SCHEDULE_ENABLED` to `true`. The runner then owns the schedule; no
Cowork production trigger exists or should be created (DR-0168).

## Failure and skip behavior

- Three skip conditions, each a clean exit before any API spend: the issues
  row for genre+month already exists in a non-draft status; the permalink
  page in the repo is already a LIVE ISSUE PAGE (a placeholder does not
  count); or the desk has no published issue to grow from (inaugurals are
  attended, DR-0168). This is how an armed quarter start coexists with
  quarterly issues that were produced attended earlier in the quarter.
  Format-invalid dispatch arguments (bad slug characters, bad month shape)
  are the one failure class that attaches no artifact.
- A stale data pack (pack_month ≠ issue month — i.e. the 05:30 pull failed)
  refuses production; `genre_reports.runner_pull_log` plus
  `net._http_response` show what happened. `--allow-stale-pack` exists for a
  deliberate manual dispatch only.
- A seat error or a verification cap-out fails that genre's matrix job; the
  artifact upload runs on failure too (`if: always()`), and every failure
  path writes a `summary.json` with `ok:false` and the error, so the
  escalation payload always says what happened. Other genres continue
  (`fail-fast: false` on both matrices), and desks that produced cleanly
  still publish — each publish leg checks its own artifact and skips absent
  or failed desks. Skips print a `::notice::` on the run page, so a skipped
  desk is visible, never silent.
- Anything unpublished by EOD on the 2nd escalates to Steve with the
  adversary's last verdict — the failed run's email from GitHub plus the
  artifacts are the escalation payload.
- Rejecting the `publish` job in the GitHub UI means that leg never runs and
  nothing ships; the run's artifacts remain for inspection (v3 has no issue
  branches — the publish job commits straight to main after approval).

## Blast radius, stated exactly

The runner's secrets can: spend API budget (bounded by Console limits,
`ROUNDS_MAX`, and the post-hoc seat cap), read data packs and genre config
(K-lytics extract only WITH the runner token), create a draft issues row for
a genre+month that lacks one, and mark an issue published with a payload that
is rendered in full on Steve's approval console (write-lane gates). The
produce job pushes nothing; only the gated publish job commits, and only the
paths its own deterministic build reports. They cannot approve a deploy
(GitHub required reviewer), approve,
arm, or dispatch a send (no surface holds those), or touch subscribers.

Accepted residuals, on the record: agent seats necessarily run with
`ANTHROPIC_API_KEY` (it is what runs them; a prompt-injected seat could burn
budget or exfiltrate that one key — Console spend limits bound the damage);
and a wrong token passed to the runner DB functions can appear in
operator-visible Postgres error logs. Everything else is structurally out of
a seat's reach: the produce job is contents:read with no persisted git
credential and no GitHub/database token in or after the seats step (the DB
token appears only in the prepare step, which runs before any seat), the
runner's file-command channels are pointed at /dev/null for the seat process
tree, and everything that writes — page build, commit, deploy, database —
happens on the publish job's fresh machine from the approved draft and HEAD
code, sharing no filesystem, environment, or git state with the seats. One
named window remains: the artifact directory lives on the seats' own disk, so
a seat-planted background process could in principle rewrite `draft.md` or
`summary.json` between the orchestrator's exit and the artifact upload —
accepted because the artifact's whole purpose is Steve's review, and the
publish job re-validates and rebuilds from that reviewed draft.

## Artifacts and the public repo

The repo is public, so workflow artifacts are publicly downloadable. The
runner uploads only `public-artifacts/` (draft, adversary reports, layout
check, screenshots, summary). K-lytics extracts live only in the job
workspace `private/` directory and in the database — never in artifacts, the
repo, or the reports — and this is enforced MECHANICALLY, not just by prompt:
on EVERY seats-phase exit path, success or failure, `produce-issue.mjs` scans
every public artifact (screenshots included) AND the built pages for extract
lines; on a hit it
QUARANTINES the offending files into the private workspace (so the artifact
upload cannot ship them), leaves a CONTAINMENT_FAILURE marker, and aborts.

The shipping containment is architectural: the publish job rebuilds the
pages FROM THE DRAFT on a fresh machine (`runner/build-pages.mjs`), commits
only the paths that build reports (validated against a path allowlist and a
porcelain check), and never consults the produce machine's working tree —
which is what makes Steve's artifact review sufficient as the deploy
approval: the draft he reviewed is the only content input to what ships.
