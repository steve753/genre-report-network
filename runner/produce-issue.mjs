// Genre Report Network — unattended issue production (DR-0168).
// Runs as PHASES so the workflow can scope secrets per step (a seat process
// never inherits a credential it does not need):
//   --phase=prepare   env: SUPABASE_URL, SUPABASE_ANON_KEY, RUNNER_DB_TOKEN
//                     fetch pack, decide skips (already delivered; no
//                     published issue to grow from; DR-0168 forbids runner
//                     inaugurals) BEFORE any spend, write ground truth.
//   --phase=seats     env: ANTHROPIC_API_KEY (+ model vars)
//                     researcher → writer → adversary rounds (min 2, zero
//                     sev-1, cap) → pages build → screenshots → layout seat.
//                     Every exit path runs the K-lytics containment guard,
//                     which QUARANTINES offending public artifacts before
//                     throwing, so the always()-upload can never ship them.
// The pages this phase builds are PREVIEWS for screenshots and Steve's
// review only — the gated publish job rebuilds the shipping pages
// deterministically from the approved draft on a fresh machine, from HEAD
// code and HEAD chrome, so nothing a seat writes into this job's working
// tree can ever reach the repo, the site, or the database.
// It NEVER deploys, publishes, or mails: the deploy is gated by the GitHub
// production environment (DR-0158) and the send by Steve's one-click approval
// (DR-0165). Exit codes: 0 done, 3 skipped (clean no-op), 2 verification
// failed (reports in artifacts), 1 hard error.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetchPack } from "./lib/pack.mjs";
import { buildIssueHtml, writePages, validateDraft, chromeIsIssuePage, PERIOD_DIR } from "./lib/pages.mjs";
import { readJson, writeFile, parseVerdict, permalinkFor, currentMonthDate, log } from "./lib/util.mjs";
import { containmentHits, extractLines, quarantine } from "./lib/containment.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const phase = args.phase;
const genre = args.genre;
if (!genre || !phase) throw new Error("--genre and --phase are required");
if (!/^[a-z0-9-]+$/.test(genre)) throw new Error(`genre slug fails validation: ${genre}`);
const monthDate = args.month || currentMonthDate();
if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(monthDate)) throw new Error(`--month must be YYYY-MM-01, got ${monthDate}`);

const ws = path.resolve(args.workspace || path.join(REPO_ROOT, "runner", "workspace", `${genre}-${monthDate}`));
const pub = path.join(ws, "public-artifacts"); // safe to upload from a public repo
const priv = path.join(ws, "private"); // NEVER uploaded: may hold K-lytics material
fs.mkdirSync(pub, { recursive: true });
fs.mkdirSync(priv, { recursive: true });

// Everything below runs inside the try so ANY failure — an unknown genre, a
// non-quarter month, a config problem — still leaves a summary.json in the
// artifact (the escalation payload). Only a format-invalid genre/month (the
// regex checks above, needed for safe paths) can fail with nothing attached.
const ROUNDS_MIN = 2; // DR-0151: one-round publication is prohibited
const ROUNDS_MAX = Number(process.env.ROUNDS_MAX || 6);
const writtenPages = []; // repo-relative paths writePages produced (informational; shipping pages are rebuilt by the publish job)
let genresConfig;
let genreCfg;
let permalink;

try {
  genresConfig = readJson(path.join(REPO_ROOT, "config", "genres.json"));
  genreCfg = genresConfig.genres.find((g) => g.slug === genre);
  if (!genreCfg) throw new Error(`unknown genre slug ${genre}`);
  if (genreCfg.tier === "quarterly" && ![1, 4, 7, 10].includes(Number(monthDate.split("-")[1]))) {
    throw new Error(`${genre} is quarterly; ${monthDate} is not a quarter start — refusing (permalink would collide with the quarter's issue)`);
  }
  permalink = permalinkFor(genre, genreCfg.tier, monthDate);
  if (phase === "prepare") await phasePrepare();
  else if (phase === "seats") await phaseSeats();
  else throw new Error(`unknown phase ${phase}`);
} catch (e) {
  // Every failure leaves a summary for the always()-uploaded artifact (the
  // escalation payload), and the seats phase leaves no unscanned artifact.
  // The guard's own throw is contained here so the ORIGINAL error is what
  // reaches stderr; a containment hit is logged and recorded in the marker.
  augmentSummary({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 800) });
  if (phase === "seats") {
    try {
      guardKlyticsQuarantine();
    } catch (g) {
      log(`CONTAINMENT during failure handling: ${g.message}`);
    }
  }
  throw e;
}

// ---------------------------------------------------------------------------
async function phasePrepare() {
  // Read the world (tolerating a missing/stale pack, so a desk that must be
  // SKIPPED is skipped cleanly rather than failing on pack state), then
  // decide the three skip conditions before a single seat token is spent.
  const packOut = await fetchPack(genre, monthDate, { deferFreshness: true });
  const existing = packOut.existing_issue;
  const permPagePath = path.join(REPO_ROOT, "public", permalink.replace(/^\/|\/$/g, ""), "index.html");
  const permPageIsRealIssue = fs.existsSync(permPagePath) && chromeIsIssuePage(fs.readFileSync(permPagePath, "utf8"));
  const homePath = path.join(REPO_ROOT, "public", genre, "index.html");
  const homeIsIssuePage = fs.existsSync(homePath) && chromeIsIssuePage(fs.readFileSync(homePath, "utf8"));

  if (existing && existing.status !== "draft") {
    return skip(`issue for ${genre} ${monthDate} already exists with status '${existing.status}'`);
  }
  if (permPageIsRealIssue) {
    return skip(`permalink page ${permalink} is already a live issue page`);
  }
  if (!homeIsIssuePage) {
    return skip(`${genre} has no published issue to grow from — inaugurals are produced attended (DR-0168)`);
  }

  // Only a produced cycle needs a fresh pack — enforce AFTER the skips.
  if (!packOut.pack) throw new Error(`no data pack exists for ${genre} — check genre_reports.runner_pull_log and net._http_response`);
  if (packOut.pack.stale && !args["allow-stale-pack"]) {
    throw new Error(
      `pack for ${genre} is STALE (pack_month ${packOut.pack.pack_month}, issue month ${monthDate}) — the 05:30 pull likely failed; check genre_reports.runner_pull_log (--allow-stale-pack overrides, deliberately only)`
    );
  }
  if (packOut.pack.stale) log(`WARNING: proceeding on a stale pack (${packOut.pack.pack_month}) under --allow-stale-pack`);

  writeFile(path.join(priv, "pack.json"), JSON.stringify(packOut.pack, null, 2));
  if (packOut.shared_pack) writeFile(path.join(priv, "shared-pack.json"), JSON.stringify(packOut.shared_pack, null, 2));
  const klyticsText = (packOut.klytics && packOut.klytics.extract_text) || "";
  if (klyticsText.trim().length > 0) writeFile(path.join(priv, "klytics-extract.txt"), klyticsText);
  else if (packOut.klytics) log("K-lytics row exists but its extract is empty — treating as ABSENT");
  writeFile(
    path.join(priv, "genre.json"),
    JSON.stringify({ ...genreCfg, permalink, monthDate, pack_month: packOut.pack.pack_month, pack_version: packOut.pack.version }, null, 2)
  );

  // Sibling issues for the cross-desk originality gate — every OTHER desk
  // with a live issue (never this desk's own home, which is its own prior
  // issue and is judged by the repetition check instead).
  const siblingUrls = [];
  for (const g of genresConfig.genres) {
    if (g.slug === genre) continue;
    const home = path.join(REPO_ROOT, "public", g.slug, "index.html");
    if (fs.existsSync(home) && chromeIsIssuePage(fs.readFileSync(home, "utf8"))) {
      siblingUrls.push(`https://reports.stevepieper.com/${g.slug}/`);
    }
  }
  writeFile(path.join(priv, "sibling-urls.txt"), siblingUrls.join("\n"));
  log("prepare complete");
}

function skip(reason) {
  writeSummary({ ok: false, skipped: true, genre, month: monthDate, reason });
  log(`SKIP: ${reason}`);
  console.log(`::notice title=${genre} ${monthDate} skipped::${reason}`);
  process.exit(3);
}

// ---------------------------------------------------------------------------
async function phaseSeats() {
  const { models, prompt, runSeat } = await import("./lib/agents.mjs");
  const M = models();
  const usage = [];
  const klyticsFresh = fs.existsSync(path.join(priv, "klytics-extract.txt"));
  const sdkVersion = readSdkVersion();

  async function seat(name, model, promptText, tools) {
    const { usage: u } = await runSeat({ seat: name, model, promptText, cwd: ws, tools });
    usage.push({ seat: name, model, ...u });
    writeFile(path.join(priv, "usage.json"), JSON.stringify(usage, null, 2));
    // Post-hoc guard: it cannot bound a single seat's spend mid-flight, but a
    // runaway seat aborts the run before further seats spend anything.
    const cap = Number(process.env.SEAT_OUTPUT_TOKEN_CAP || 0);
    if (cap && u.output_tokens > cap) throw new Error(`seat ${name} exceeded SEAT_OUTPUT_TOKEN_CAP (${u.output_tokens} > ${cap})`);
  }
  const FULL = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]; // research + adversary need computation and fetching
  const WRITE_ONLY = ["Read", "Write", "Edit", "Glob", "Grep"]; // the writer neither fetches nor shells

  // A structurally invalid draft costs ONE repair seat-call, not the run:
  // the problems are written to a file and the writer fixes exactly those.
  async function validateOrRepair(when) {
    let problems = draftProblems(when);
    if (problems.length === 0) return;
    log(`draft invalid ${when}: ${problems.join("; ")} — running one repair pass`);
    writeFile(path.join(priv, "draft-problems.txt"), problems.join("\n"));
    await seat(`writer-repair`, M.writer, prompt("writer-repair", {}), WRITE_ONLY);
    problems = draftProblems(`${when} (after repair)`);
    if (problems.length > 0) throw new Error(`draft invalid ${when} even after repair: ${problems.join("; ")}`);
  }

  await seat("researcher", M.research, prompt("researcher", {
    genre,
    tier: genreCfg.tier,
    month: monthDate,
    permalink,
    klytics_state: klyticsFresh
      ? "A fresh K-lytics extract is at private/klytics-extract.txt; the K-lytics policy in your brief governs its use."
      : "NO fresh K-lytics extract exists this cycle. Use no K-lytics material anywhere, and add a production note that the issue ran without it.",
  }), FULL);
  mustExist("private/dossier.md", "researcher produced no dossier");

  await seat("writer", M.writer, prompt("writer", {
    genre,
    tier: genreCfg.tier,
    cadence_word: genreCfg.tier === "monthly" ? "Monthly" : "Quarterly",
    display_name: genreCfg.display_name,
    month: monthDate,
    permalink,
  }), WRITE_ONLY);
  await validateOrRepair("after the writer seat");

  // Adversary rounds: cross-model, minimum two, zero severity-1, hard cap.
  let round = 0;
  let released = false;
  const roundHistory = [];
  while (round < ROUNDS_MAX) {
    round += 1;
    await seat(`adversary-r${round}`, M.adversary, prompt("adversary", { genre, round }), FULL);
    const reportPath = path.join(priv, `adversary-round${round}.md`);
    if (!fs.existsSync(reportPath)) throw new Error(`adversary round ${round} wrote no report`);
    fs.copyFileSync(reportPath, path.join(pub, `adversary-round${round}.md`));
    const v = parseVerdict(fs.readFileSync(reportPath, "utf8"));
    roundHistory.push({ round, ...v });
    log(`adversary round ${round}: ${v.verdict} (${v.sev1}/${v.sev2}/${v.sev3})`);
    const clean = v.parsed && v.verdict === "RELEASE" && v.sev1 === 0;
    if (clean && round >= ROUNDS_MIN) {
      released = true;
      break;
    }
    if (round >= ROUNDS_MAX) break;
    if (!clean) {
      // A clean round below the minimum goes straight to the confirming
      // round — no fixes pass against a draft the adversary just cleared.
      await seat(`writer-fixes-r${round}`, M.writer, prompt("writer-fixes", { round }), WRITE_ONLY);
      await validateOrRepair(`after fixes round ${round}`);
    }
  }
  writeFile(path.join(priv, "rounds.json"), JSON.stringify(roundHistory, null, 2));
  if (!released) {
    writeSummary({ ok: false, reason: "verification did not reach RELEASE within the round cap", roundHistory, sdk_version: sdkVersion });
    guardKlyticsQuarantine();
    log("FAILED verification — escalating per the failure policy");
    process.exit(2);
  }

  // Pages (deterministic) from the genre home chrome, then screenshots and
  // the mechanical layout seat.
  const draftText = fs.readFileSync(path.join(priv, "draft.md"), "utf8");
  const issueNumber = String(args["issue-number"] || nextIssueNumber()).padStart(3, "0");
  // Snapshot the exact draft that is being built into the artifact NOW, from
  // memory — the layout seat runs later with Write, and the artifact draft is
  // the publish job's only content input.
  writeFile(path.join(pub, "draft.md"), draftText);
  const built = buildIssueHtml({
    draftText,
    chromeHtml: fs.readFileSync(path.join(REPO_ROOT, "public", genre, "index.html"), "utf8"),
    genreCfg,
    monthDate,
    issueNumber,
  });
  const pages = writePages({ repoRoot: REPO_ROOT, genre, permalink, html: built.html, issueNumber, archLabel: built.archiveLabelUsed });
  writtenPages.push(...pages.repoRelative);
  log(`pages written: ${pages.repoRelative.join(", ")}`);

  execFileSync("bash", [path.join(REPO_ROOT, "runner", "lib", "screenshot.sh"), path.join(REPO_ROOT, "public"), permalink, pub], { stdio: "inherit" });
  await seat("layout-check", M.mechanical, prompt("layout-check", {}), ["Read", "Write", "Glob"]);
  const layoutPath = path.join(priv, "layout-check.md");
  if (!fs.existsSync(layoutPath)) throw new Error("layout seat wrote no report");
  fs.copyFileSync(layoutPath, path.join(pub, "layout-check.md"));
  const layoutLines = fs.readFileSync(layoutPath, "utf8").trim().split("\n");
  const layoutPassed = layoutLines[layoutLines.length - 1].trim() === "LAYOUT: PASS";

  // The artifact draft must be exactly what was built and screenshotted — a
  // layout seat that touched it invalidates the run.
  if (fs.readFileSync(path.join(pub, "draft.md"), "utf8") !== draftText) {
    throw new Error("artifact draft.md changed after the build — refusing to hand this to the publish gate");
  }
  writeSummary({
    ok: layoutPassed,
    ...(layoutPassed ? {} : { reason: "layout check failed" }),
    genre,
    month: monthDate,
    permalink: built.canonical,
    issue_number: issueNumber,
    pack_month: readJson(path.join(priv, "genre.json")).pack_month,
    pack_version: readJson(path.join(priv, "genre.json")).pack_version,
    sdk_version: sdkVersion,
    adversary_rounds: round,
    adversary_verdict: `RELEASE after ${round} rounds (${roundHistory.map((r) => `${r.sev1 ?? "?"} sev-1`).join("; ")})`,
    story_count: Array.isArray(built.frontmatter.stories) ? built.frontmatter.stories.length : null,
    klytics_used: klyticsFresh,
    written_pages: writtenPages,
    send_payload: {
      genre,
      subject: built.frontmatter.email_subject,
      teaser_bullets: built.frontmatter.teaser_bullets,
      permalink_url: built.canonical,
    },
    usage,
  });
  guardKlyticsQuarantine();
  if (!layoutPassed) process.exit(2);
  log("seats phase complete");
}

// ---- helpers ----
function draftProblems(when) {
  const p = path.join(priv, "draft.md");
  if (!fs.existsSync(p)) return [`no draft.md ${when}`];
  try {
    const v = validateDraft(fs.readFileSync(p, "utf8"));
    return v.ok ? [] : v.problems;
  } catch (e) {
    return [e.message];
  }
}

function mustExist(rel, msg) {
  if (!fs.existsSync(path.join(ws, rel))) throw new Error(msg);
}

function nextIssueNumber() {
  const genreDir = path.join(REPO_ROOT, "public", genre);
  const n = fs
    .readdirSync(genreDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PERIOD_DIR.test(e.name)).length;
  return n + 1;
}

function readSdkVersion() {
  try {
    return readJson(path.join(REPO_ROOT, "runner", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")).version;
  } catch {
    return "unknown";
  }
}

// The extract is licensed material; the artifacts and the built pages are
// world-readable. Prompt text alone is not a control, so verify mechanically
// on EVERY seats-phase exit path: no substantial line of the extract may
// appear in any public artifact or built page. Offending artifacts are
// QUARANTINED into private/ before this throws, so the workflow's always()
// upload cannot ship them. This function itself never throws for any reason
// other than a containment hit.
function guardKlyticsQuarantine() {
  let extractText;
  try {
    if (!fs.existsSync(path.join(priv, "klytics-extract.txt"))) return;
    extractText = fs.readFileSync(path.join(priv, "klytics-extract.txt"), "utf8");
  } catch {
    return;
  }
  if (extractLines(extractText).length === 0) return;
  const targets = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) targets.push(p); // .png renders scan fine as utf8 and never false-positive
    }
  };
  walk(pub);
  for (const rel of writtenPages) {
    const p = path.join(REPO_ROOT, rel);
    if (fs.existsSync(p)) targets.push(p);
  }
  const hits = containmentHits(extractText, targets);
  if (hits.length === 0) {
    log(`K-lytics containment check passed on ${targets.length} file(s)`);
    return;
  }
  // On any hit, quarantine the ENTIRE public-artifacts tree (the .png page
  // renders included) plus any hit preview page, leaving only the marker.
  let priorError = "";
  try {
    priorError = JSON.parse(fs.readFileSync(path.join(pub, "summary.json"), "utf8")).error || "";
  } catch {}
  quarantine({ hits, publicDir: pub, quarantineDir: path.join(priv, "quarantine"), repoRoot: REPO_ROOT, priorError });
  throw new Error(`K-lytics containment: ${hits.length} file(s) contained extract lines — all artifacts quarantined; run aborted`);
}

function writeSummary(obj) {
  writeFile(path.join(pub, "summary.json"), JSON.stringify(obj, null, 2));
}

function augmentSummary(patch) {
  let base = {};
  try {
    base = readJson(path.join(pub, "summary.json"));
  } catch {}
  try {
    writeSummary({ ...base, sdk_version: readSdkVersion(), ...patch, genre, month: monthDate });
  } catch {}
}
