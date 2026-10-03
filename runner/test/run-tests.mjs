// Executable checks for the runner's deterministic core (DR-0113: a check
// that never runs the artifact has no failure mode). Run: npm test
import { parseVerdict, genresDue, permalinkFor, inlineMd } from "../lib/util.mjs";
import { buildIssueHtml } from "../lib/pages.mjs";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

let v = parseVerdict("## VERDICT: **REJECT**\n\n**Counts: 9 severity-1 · 18 severity-2 · 9 severity-3.**");
assert.deepEqual([v.verdict, v.sev1, v.sev2, v.sev3, v.parsed], ["REJECT", 9, 18, 9, true]);
assert.equal(parseVerdict("no verdict line").verdict, "REJECT");

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/genres.json"), "utf8"));
// derived from the config, so adding a desk does not break the check
assert.deepEqual(genresDue(cfg, "2026-11-01"), cfg.genres.filter((g) => g.tier === "monthly").map((g) => g.slug));
assert.ok(genresDue(cfg, "2026-11-01").includes("thriller"));
assert.equal(genresDue(cfg, "2026-10-01").length, cfg.genres.length);

assert.equal(permalinkFor("thriller", "monthly", "2026-10-01"), "/thriller/oct-2026/");
assert.equal(permalinkFor("mystery", "quarterly", "2026-10-01"), "/mystery/q4-2026/");

assert.equal(
  inlineMd("A **bold** [link](https://x.com/a) & <tag>"),
  'A <strong>bold</strong> <a href="https://x.com/a">link</a> &amp; &lt;tag&gt;'
);

// pages builder against whichever genre chrome exists
const chromePath = ["thriller/sep-2026", "mystery/q4-2026", "romance/q4-2026"]
  .map((p) => path.join(ROOT, "public", p, "index.html"))
  .find((p) => fs.existsSync(p));
const draft = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixture-draft.md"), "utf8");
const genreCfg = cfg.genres.find((g) => g.slug === "thriller");
const out = buildIssueHtml({
  draftText: draft,
  chromeHtml: fs.readFileSync(chromePath, "utf8"),
  genreCfg, monthDate: "2026-10-01", issueNumber: "003",
});
assert.ok(out.html.includes('href="https://reports.stevepieper.com/thriller/oct-2026/"'), "canonical");
assert.ok(out.html.includes('<span class="sec">THE HEADLINE:</span>'), "section label");
assert.ok(out.html.indexOf('class="offer"') > out.html.indexOf("Money text"), "offer card placement");
assert.ok(/<figure class="(databox|slotshare)">/.test(out.html), "figure passthrough with chrome-derived class");
assert.equal((out.html.match(/<main>/g) || []).length, 1, "single main");
assert.ok(!out.html.includes("This is the permanent edition"), "chrome permanent-edition line stripped");
// A built issue page carries the desk's signup redirect from the chrome (Steve, 2026-10-03).
assert.ok(out.html.includes("location.replace('/thriller/check-your-inbox/')"), "built page sends a signup to the thriller confirmation page");

// monthly desk must never default to "Quarterly" in the title tag
import { defaultTitleTag, validateDraft } from "../lib/pages.mjs";
assert.ok(defaultTitleTag(genreCfg, "003", "2026-10-01").startsWith("Thriller Monthly"), "monthly title tag");

// column-0 frontmatter lists parse, and validateDraft enforces the send-gate shape
// column-0 lists parse identically
const col0 = draft.replace(/  - bullet/g, "- bullet").replace(/  - story one/, "- story one");
assert.ok(validateDraft(col0).ok, JSON.stringify(validateDraft(col0).problems));
// too-few teasers are rejected before any page or deploy
const oneBullet = draft.replace(/  - bullet two\n  - bullet three\n/, "");
const vBad = validateDraft(oneBullet);
assert.ok(vBad.problems.some((p) => p.includes("teaser_bullets")), "1-bullet draft rejected (needs 3-6)");

// --- round-4 control coverage ---
import { assertFigureSafe, chromeIsIssuePage } from "../lib/pages.mjs";
import { execFileSync } from "node:child_process";
import os from "node:os";

// figure sanitizer: the full attack table throws; the fixture's clean SVG passes
for (const bad of [
  '<figure><script>alert(1)</script></figure>',
  '<figure><svg onload="x()"></svg></figure>',
  '<figure><svg/onload="x()"></svg></figure>',
  '<figure><iframe src="https://x"></iframe></figure>',
  '<figure><a href="javascript:x">x</a></figure>',
  '<figure><svg><a xlink:href="&#106;avascript:alert(1)">x</a></svg></figure>',
  '<figure><set attributeName="onload" to="x"/></figure>',
  '<figure><svg><image href="data:x"/></svg></figure>',
  '<figure><div style="background:url(//evil/x)">x</div></figure>',
  '<figure><div style=background:url(//evil/x)>x</div></figure>',
  '<figure><style>svg{background:\\75 rl(//evil)}</style></figure>',
  "<figure><div a=x'><script>evil()</script></div></figure>",
  '<figure><style>svg{color:red}</figure>',
  '<figure><!--><script>alert(1)</script><!-- --></figure>',
  '<figure><!-- x --!><script>alert(1)</script><!-- --></figure>',
  '<figure><style>@media screen{.offer{position:fixed;inset:0}}</style></figure>',
  '<figure><style>:not(svg) body{display:none}</style></figure>',
  // round-9: a "}" hidden in a CSS comment or string must not blind the selector segmenter
  '<figure><style>.offer,/*}*/ svg{position:fixed;inset:0;z-index:2147483647;background:#fff}</style></figure>',
  '<figure><style>svg{fill:red} body,[x="}"] svg{display:none}</style></figure>',
  '<figure><style>@media screen{.offer,/*}*/ svg{position:fixed;inset:0}}</style></figure>',
  // round-9: sibling/adjacent combinators reach out of the figure
  '<figure><style>figure ~ *{display:none}</style></figure>',
  '<figure><style>figure + p{display:none}</style></figure>',
  // round-10: CSS terminates strings on CR and FF as well as LF (Syntax §3.3
  // preprocessing) — a \r or \f spelling must refuse exactly like the \n one
  '<figure><style>svg{content:"\r} .offer{position:fixed;inset:0}"}</style></figure>',
  '<figure><style>svg{content:"\f} .offer{position:fixed;inset:0}"}</style></figure>',
  // round-10: unterminated comments/strings are ambiguous — refused outright
  '<figure><style>svg{a:b} .offer,/* } svg{position:fixed}</style></figure>',
  '<figure><style>svg{a:b} .offer,[x="}] svg{display:none}</style></figure>',
  '<figure><div><title>x</div></figure>',
  '<figure><foreignObject>x</foreignObject></figure>',
]) {
  let threw = false;
  try { assertFigureSafe(bad); } catch { threw = true; }
  assert.ok(threw, "sanitizer must reject: " + bad);
}
assertFigureSafe('<figure><svg viewBox="0 0 10 10"><rect/></svg><figcaption>ok</figcaption></figure>');

// chrome contract: live issue pages pass, placeholders fail
const FIXTURE_THRILLER = path.join(ROOT, "runner/test/fixtures/public-thriller-as-of-sep-2026");
assert.ok(chromeIsIssuePage(fs.readFileSync(path.join(FIXTURE_THRILLER, "index.html"), "utf8")), "a published issue home is an issue page");
// The placeholder case uses a page derived from a frozen issue page with one
// required element removed, NOT a live genre home: every desk's home became an
// issue page as desks launched (Horror on 2026-09-05), which silently broke
// the earlier live-page form of this check while nothing ran the tests.
const thrillerHome = fs.readFileSync(path.join(FIXTURE_THRILLER, "index.html"), "utf8");
assert.ok(thrillerHome.includes('<aside class="offer"'), "fixture source carries the offer aside");
assert.ok(!chromeIsIssuePage(thrillerHome.replaceAll('<aside class="offer"', '<aside class="gone"')), "a page missing the offer aside is not an issue page");
assert.ok(!chromeIsIssuePage("<html><body><h1>Coming soon</h1></body></html>"), "a coming-soon page is not an issue page");

// build-pages end to end into a temp copy of the repo tree
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
// From a FROZEN copy of the thriller desk as it stood after Issue 002
// (Sep 2026), not from live public/thriller: once the October issue is
// published, the live tree already holds /thriller/oct-2026/ and the build
// refuses to overwrite it, which would fail every later production run at the
// self-tests step.
fs.cpSync(FIXTURE_THRILLER, path.join(tmp, "public/thriller"), { recursive: true });
fs.cpSync(path.join(ROOT, "config"), path.join(tmp, "config"), { recursive: true });
fs.cpSync(path.join(ROOT, "runner/lib"), path.join(tmp, "runner/lib"), { recursive: true });
fs.cpSync(path.join(ROOT, "runner/build-pages.mjs"), path.join(tmp, "runner/build-pages.mjs"));
const draftFile = path.join(tmp, "draft.md");
fs.writeFileSync(draftFile, draft);
const outLine = execFileSync("node", [path.join(tmp, "runner/build-pages.mjs"), draftFile, "--genre=thriller", "--month=2026-10-01"]).toString().trim();
const bp = JSON.parse(outLine);
assert.ok(bp.written.includes("public/thriller/oct-2026/index.html"), "permanent page recorded");
assert.ok(bp.written.includes("public/thriller/index.html"), "genre home recorded");
assert.ok(bp.written.some((w) => w.endsWith("sep-2026/index.html")), "prior permalink archive update recorded");
const perm = fs.readFileSync(path.join(tmp, "public/thriller/oct-2026/index.html"), "utf8");
const home = fs.readFileSync(path.join(tmp, "public/thriller/index.html"), "utf8");
assert.equal((perm.match(/This is the permanent edition/g) || []).length, 1, "exactly one permanent line on permalink page");
assert.ok(perm.includes("permanent edition of Issue 003"), "permanent line carries issue number");
assert.ok(!home.includes("This is the permanent edition"), "no permanent line on genre home");
const prior = fs.readFileSync(path.join(tmp, "public/thriller/sep-2026/index.html"), "utf8");
assert.ok(prior.includes('value="/thriller/oct-2026/">October 2026 — Issue 003<'), "prior page archive label matches archiveLabelUsed");
fs.rmSync(tmp, { recursive: true, force: true });

// the publish gate predicate (the SAME function the workflow imports) fails closed
import { shippableSummary } from "../lib/util.mjs";
for (const bad of [null, { ok: false }, { ok: true }, { ok: true, send_payload: {} }]) {
  assert.equal(shippableSummary(bad), false);
}
assert.equal(shippableSummary({ ok: true, send_payload: { subject: "x" } }), true);

// href quote injection is neutralized in ordinary prose links
assert.ok(!inlineMd('See [x](https://x.com/a"onerror="alert`1`).').includes('"onerror='), "href quote escaped");

// statistical captions are NOT false-positived by the handler check
assertFigureSafe('<figure><svg viewBox="0 0 1 1"/><figcaption>online = 62% of unit sales; n = 1,240</figcaption></figure>');
let entityThrew = false;
try { assertFigureSafe('<figure><svg><a xlink:href="&#106;avascript:alert(1)">x</a></svg></figure>'); } catch { entityThrew = true; }
assert.ok(entityThrew, "numeric-entity smuggling rejected");

// the built page's figure class is one its own CSS styles
const figMatch = perm.match(/<figure class="([a-z]+)"/);
assert.ok(figMatch, "built page has a figure");
assert.ok(perm.includes(`figure.${figMatch[1]}{`) || perm.includes(`figure.${figMatch[1]} {`), `figure class ${figMatch[1]} styled by page CSS`);

// containment scan: detects extract lines in text AND png-named files, ignores clean ones
import { containmentHits } from "../lib/containment.mjs";
const ctmp = fs.mkdtempSync(path.join(os.tmpdir(), "containment-"));
const extract = "HEADER\nThriller shelf: 958 estimated sales per day per top-20 title, August table\nshort line\n";
fs.writeFileSync(path.join(ctmp, "clean.md"), "nothing to see; figures only: 424, +2%.");
fs.writeFileSync(path.join(ctmp, "leaky.md"), "quote: Thriller shelf: 958 estimated sales per day per top-20 title, August table.");
fs.writeFileSync(path.join(ctmp, "leaky.png"), "PNGJUNK Thriller shelf: 958 estimated sales per day per top-20 title, August table");
const hits = containmentHits(extract, ["clean.md", "leaky.md", "leaky.png"].map((f) => path.join(ctmp, f)));
assert.equal(hits.length, 2, "both leaky files detected, png included");
assert.ok(hits.every((h) => h.includes("leaky")), "clean file not flagged");
assert.equal(containmentHits("short\nlines\nonly", [path.join(ctmp, "leaky.md")]).length, 0, "no substantial lines = no hits");
fs.rmSync(ctmp, { recursive: true, force: true });

// full live-figure census: every figure on every live page must pass the sanitizer
let census = 0;
for (const g of cfg.genres.map((g) => g.slug)) {
  const gdir = path.join(ROOT, "public", g);
  if (!fs.existsSync(gdir)) continue;
  for (const d of fs.readdirSync(gdir, { withFileTypes: true })) {
    const pg = d.isDirectory() ? path.join(gdir, d.name, "index.html") : null;
    for (const file of [pg, d.name === "index.html" ? path.join(gdir, d.name) : null]) {
      if (!file || !fs.existsSync(file)) continue;
      for (const fig of fs.readFileSync(file, "utf8").match(/<figure[\s\S]*?<\/figure>/g) || []) {
        assertFigureSafe(fig);
        census++;
      }
    }
  }
}
assert.ok(census >= 4, `live-figure census ran (${census} figures)`);

// quarantine mechanics: everything leaves publicDir, hits outside are removed, marker remains
import { quarantine } from "../lib/containment.mjs";
const qtmp = fs.mkdtempSync(path.join(os.tmpdir(), "quarantine-"));
const qpub = path.join(qtmp, "pub"); const qpriv = path.join(qtmp, "priv");
fs.mkdirSync(qpub, { recursive: true });
fs.writeFileSync(path.join(qpub, "draft.md"), "leaky");
fs.writeFileSync(path.join(qpub, "page-top.png"), "png bytes");
fs.mkdirSync(path.join(qtmp, "public", "x"), { recursive: true });
const previewPage = path.join(qtmp, "public", "x", "index.html");
fs.writeFileSync(previewPage, "leaky page");
quarantine({ hits: [path.join(qpub, "draft.md"), previewPage], publicDir: qpub, quarantineDir: path.join(qpriv, "quarantine"), repoRoot: qtmp, priorError: "seat exploded" });
const left = fs.readdirSync(qpub);
assert.deepEqual(left, ["CONTAINMENT_FAILURE.md"], "only the marker remains in publicDir");
assert.ok(!fs.existsSync(previewPage), "hit preview page removed");
assert.ok(fs.existsSync(path.join(qpriv, "quarantine", "draft.md")), "artifact quarantined");
assert.ok(fs.existsSync(path.join(qpriv, "quarantine", "public__x__index.html")), "preview page quarantined by repo-relative name");
const marker = fs.readFileSync(path.join(qpub, "CONTAINMENT_FAILURE.md"), "utf8");
assert.ok(marker.includes("seat exploded"), "marker carries the original error");
fs.rmSync(qtmp, { recursive: true, force: true });

// ---- seats-phase time budget (thriller shakedown 2026-10-02: the job was
// killed mid-round, leaving no summary and no escalation) ----
import { makeBudget, budgetMinutesFromEnv, BUDGET_MARGIN_MINUTES, DEFAULT_FLOORS_MINUTES } from "../lib/budget.mjs";
{
  // refuses without a step limit
  for (const bad of [{}, { SEATS_STEP_TIMEOUT_MINUTES: "" }, { SEATS_STEP_TIMEOUT_MINUTES: "abc" }, { SEATS_STEP_TIMEOUT_MINUTES: String(BUDGET_MARGIN_MINUTES) }]) {
    assert.throws(() => budgetMinutesFromEnv(bad), /SEATS_STEP_TIMEOUT_MINUTES/, "budget refuses " + JSON.stringify(bad));
  }
  assert.equal(budgetMinutesFromEnv({ SEATS_STEP_TIMEOUT_MINUTES: "250" }), 250 - BUDGET_MARGIN_MINUTES);

  // fake clock replaying the shakedown: research+writer 37 min, then rounds
  let t = 0;
  const min = (m) => m * 60000;
  const b = makeBudget({ budgetMinutes: 142, startedAtMs: 0, nowMs: () => t });
  t = min(37);
  assert.ok(b.canStartReview().ok, "first review fits");
  // floors apply before anything is observed
  assert.equal(b.estimate("adversary"), DEFAULT_FLOORS_MINUTES.adversary);
  b.record("adversary", min(33.5));
  assert.equal(Number(b.estimate("adversary").toFixed(1)), 33.5, "a review longer than the floor raises the estimate");
  b.record("adversary", min(18.5));
  assert.equal(Number(b.estimate("adversary").toFixed(1)), 33.5, "a shorter review never lowers it");
  b.record("fixes", min(4));
  assert.equal(b.estimate("fixes"), DEFAULT_FLOORS_MINUTES.fixes, "floor holds when observed is shorter");
  // with 142 - 95 = 47 min left: a review (33.5) + tail (12) = 45.5 fits; fixes (8) + review + tail = 53.5 does not
  t = min(95);
  assert.ok(b.canStartReview().ok, "a review that fits is allowed");
  assert.ok(!b.canStartFixes().ok, "a fix pass whose judging review cannot fit is refused");
  t = min(100);
  assert.ok(!b.canStartReview().ok, "a review that cannot finish with the tail is refused");
  const snap = b.snapshot();
  assert.equal(snap.budget_minutes, 142);
  assert.equal(snap.remaining_minutes, 42);
}

// ---- the workflow's time limits must nest: job > seats step > runner budget ----
{
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/produce-issue.yml"), "utf8");
  const produceJob = wf.slice(wf.indexOf("\n  produce:\n"), wf.indexOf("\n  publish:\n"));
  assert.ok(produceJob.length > 0, "produce job located");
  const jobLimit = Number((produceJob.match(/^    timeout-minutes: (\d+)\s*$/m) || [])[1]);
  const stepLimit = Number((produceJob.match(/^      SEATS_STEP_TIMEOUT_MINUTES: "(\d+)"\s*$/m) || [])[1]);
  assert.ok(jobLimit > 0 && stepLimit > 0, `both limits parsed (job ${jobLimit}, step ${stepLimit})`);
  assert.ok(jobLimit >= stepLimit + 15, `job limit ${jobLimit} must be at least 15 minutes above the seats step limit ${stepLimit}`);
  const seatsStep = produceJob.slice(produceJob.indexOf("id: seats"), produceJob.indexOf("- name: Upload review artifacts"));
  assert.ok(seatsStep.includes("timeout-minutes: ${{ fromJSON(env.SEATS_STEP_TIMEOUT_MINUTES) }}"), "seats step takes its limit from the one shared number");
  // the budget must fit research + writer (37 min measured) plus the DR-0151
  // minimum of two reviews, one fix pass and the pages/layout tail
  const F = DEFAULT_FLOORS_MINUTES;
  const minimumRun = 40 + 2 * F.adversary + F.fixes + F.tail;
  assert.ok(stepLimit - BUDGET_MARGIN_MINUTES >= minimumRun, `budget ${stepLimit - BUDGET_MARGIN_MINUTES} min cannot fit the minimum run of ${minimumRun} min`);
  // the self-tests step runs before any credential or spend
  const selfTests = produceJob.indexOf("        run: cd runner && npm test\n");
  assert.ok(selfTests > 0 && selfTests < produceJob.indexOf("id: prepare"), "self-tests step runs before Prepare");
}


// Figure classes (Thriller issue 003, run 37070763676): a figure whose <style>
// anchors on its own .ch* class must keep that class on the page, beside the
// chrome's panel class; a <style> anchored on a class nothing in the figure
// carries is refused rather than shipped unstyled.
import { figureClassList } from "../lib/pages.mjs";
{
  const own = '<figure class="chku"><style>.chku { --a: #000; } :root[data-theme="dark"] .chku { --a: #fff; } .chku .chs1 { fill: var(--a); }</style><svg viewBox="0 0 1 1"><rect class="chs1"/></svg><figcaption>x</figcaption></figure>';
  assert.strictEqual(figureClassList(own, "slotshare"), "slotshare chku", "the draft figure's own .ch* class is kept beside the chrome class");
  assert.strictEqual(figureClassList('<figure><svg viewBox="0 0 1 1"/></figure>', "databox"), "databox", "a classless figure gets the chrome class only");
  assert.strictEqual(figureClassList('<figure class="chku"><style>.chku .chs1 { fill: red; } .chku .chs2 { fill: blue; } /* like .chart */</style><svg viewBox="0 0 1 1"><rect class="chs1"/></svg></figure>', "slotshare"), "slotshare chku", "an unused series rule under a carried anchor, and a comment, are not refused");
  assert.throws(() => figureClassList('<figure class="chku"><style>svg.chpx rect { fill: red; }</style><svg viewBox="0 0 1 1"/></figure>', "slotshare"), /anchors on \.chpx/, "an anchor written as svg.chpx is checked too");
  assert.strictEqual(figureClassList('<figure class="chx evil"><style>.chx svg { fill: red; }</style><svg viewBox="0 0 1 1"/></figure>', "slotshare"), "slotshare chx", "only .ch* tokens are carried over from the draft");
  assert.throws(() => figureClassList('<figure class="chku"><style>.chpx svg { fill: red; }</style><svg viewBox="0 0 1 1"/></figure>', "slotshare"), /anchors on \.chpx/, "a style anchored on a class no element carries is refused");
  {
    const base = fs.readFileSync(path.join(ROOT, "runner/test/fixture-draft.md"), "utf8");
    const mismatched = base.replace(/<figure>[\s\S]*?<\/figure>/, '<figure class="chku"><style>.chpx svg { fill: red; }</style><svg viewBox="0 0 1 1"/></figure>');
    const vd = validateDraft(mismatched);
    assert.ok(!vd.ok && vd.problems.some((m) => /anchors on \.chpx/.test(m)), "validateDraft reports the mismatch so the writer-repair pass sees it");
  }
  // the shipped issue's two figures, exactly as the writer produced them
  const draft = fs.readFileSync(path.join(ROOT, "runner/test/fixtures/thriller-003-figures.md"), "utf8");
  const figs = draft.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/g) || [];
  assert.strictEqual(figs.length, 2, "issue 003 fixture carries its two figures");
  assert.deepStrictEqual(figs.map((f) => figureClassList(f, "slotshare")), ["slotshare chku", "slotshare chpx"], "issue 003 figures keep their own classes");
  // end to end through the real page build: the fixture draft with issue
  // 003's figures in place of its own, on the frozen thriller chrome
  const baseDraft = fs.readFileSync(path.join(ROOT, "runner/test/fixture-draft.md"), "utf8");
  const withFigs = baseDraft.replace(/<figure>[\s\S]*?<\/figure>/, figs.join("\n\n"));
  assert.notStrictEqual(withFigs, baseDraft, "fixture draft carried a figure to replace");
  const built = buildIssueHtml({
    draftText: withFigs,
    chromeHtml: fs.readFileSync(path.join(ROOT, "runner/test/fixtures/public-thriller-as-of-sep-2026/sep-2026/index.html"), "utf8"),
    genreCfg: cfg.genres.find((g) => g.slug === "thriller"), monthDate: "2026-10-01", issueNumber: "003",
  });
  const classes = [...built.html.matchAll(/<figure class="([^"]*)">/g)].map((m) => m[1]);
  assert.deepStrictEqual(classes, ["slotshare chku", "slotshare chpx"], "built page keeps each figure's own class");
}

// Every live page with a signup form sends a successful signup to ITS OWN desk's confirmation page, and that page
// exists with Steve's copy (2026-10-03). A page that only changed the button text would leave a new subscriber with no
// instruction to confirm -- the gap The Dangle's ad testing exposed.
{
  const pub = path.join(ROOT, "public");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const forms = walk(pub).filter((f) => f.endsWith(".html") && fs.readFileSync(f, "utf8").includes("/api/subscribe"));
  assert.ok(forms.length >= 6, `signup forms found: ${forms.length}`);
  for (const f of forms) {
    const html = fs.readFileSync(f, "utf8");
    const genre = (html.match(/genre: '([a-z-]+)'/) || [])[1];
    assert.ok(genre, `${f}: form names its genre`);
    assert.ok(/state === 'confirmation-sent'\) \{[^}]*location\.replace\('\/([a-z-]+)\/check-your-inbox\/'\)/.test(html)
      && html.match(/state === 'confirmation-sent'\) \{[^}]*location\.replace\('\/([a-z-]+)\/check-your-inbox\/'\)/)[1] === genre,
      `${f}: a confirmation-sent signup goes to /${genre}/check-your-inbox/`);
    assert.ok(html.includes("fbc: (() => { try { return sessionStorage.getItem('gr_fbc')") && html.includes("sessionStorage.setItem('gr_fbc'"), `${f}: the signup sends the ad click's fbc`);
    const page = path.join(pub, genre, "check-your-inbox", "index.html");
    assert.ok(fs.existsSync(page), `${page} exists`);
    const p = fs.readFileSync(page, "utf8");
    assert.ok(p.includes("Almost there!") && p.includes("Please check your inbox to confirm your subscription to Steve Pieper's Genre Report.")
      && p.includes("If the email doesn't arrive within 3 minutes, please check your spam folder(s).") && p.includes('content="noindex"') && !/rel="canonical"/.test(p), `${page} carries the approved copy, stays noindex and names no canonical`);
  }
}

// A desk that has published an issue no longer tells a visitor its first issue is "in production", and its
// skeptics' link goes to its OWN desk home, which always serves the current issue -- not to a fixed issue address
// that goes stale when the next issue publishes, and not to another desk (2026-10-03: four desks still said
// "Issue 001 is in production" and pointed at the thriller desk after their Q4 issues went live).
{
  const pub = path.join(ROOT, "public");
  for (const { slug } of cfg.genres) {
    const dir = path.join(pub, slug);
    const issues = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["subscribe", "check-your-inbox"].includes(e.name) && fs.existsSync(path.join(dir, e.name, "index.html"))) : [];
    if (!issues.length) continue;
    const sub = path.join(dir, "subscribe", "index.html");
    assert.ok(fs.existsSync(sub), `${sub} exists`);
    const para = (fs.readFileSync(sub, "utf8").match(/<p class="firstissue">([\s\S]*?)<\/p>/) || [])[1];
    assert.ok(para, `${sub}: carries its first-issue paragraph`);
    assert.ok(!/in production/i.test(para), `${sub}: a desk with a published issue does not say it is in production`);
    const hrefs = [...para.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(hrefs, [`https://reports.stevepieper.com/${slug}/`], `${sub}: the skeptics' link goes to the ${slug} desk home`);
  }
}

// The site Worker's Conversions API events (src/index.js), checked offline against a copy that loads its JSON config
// with an import attribute (Wrangler bundles the bare import; Node needs the attribute).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capi-"));
  fs.mkdirSync(path.join(tmp, "src")); fs.mkdirSync(path.join(tmp, "config"));
  fs.copyFileSync(path.join(ROOT, "config/genres.json"), path.join(tmp, "config/genres.json"));
  const src = fs.readFileSync(path.join(ROOT, "src/index.js"), "utf8")
    .replace('import genresConfig from "../config/genres.json";', 'import genresConfig from "../config/genres.json" with { type: "json" };');
  assert.ok(src.includes('with { type: "json" }'), "worker config import found for the CAPI check");
  fs.writeFileSync(path.join(tmp, "src/index.mjs"), src);
  const out = execFileSync(process.execPath, [path.join(ROOT, "runner/test/worker-capi.mjs"), path.join(tmp, "src/index.mjs")]).toString();
  assert.ok(out.includes("CAPI harness PASS"), "worker CAPI check passes");
}

console.log("all runner tests PASS");
