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
assert.deepEqual(genresDue(cfg, "2026-11-01"), ["thriller"]);
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
assert.ok(chromeIsIssuePage(fs.readFileSync(path.join(ROOT, "public/thriller/index.html"), "utf8")), "thriller home is an issue page");
assert.ok(!chromeIsIssuePage(fs.readFileSync(path.join(ROOT, "public/horror/index.html"), "utf8")), "horror home is a placeholder");

// build-pages end to end into a temp copy of the repo tree
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
fs.cpSync(path.join(ROOT, "public/thriller"), path.join(tmp, "public/thriller"), { recursive: true });
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

console.log("all runner tests PASS");
