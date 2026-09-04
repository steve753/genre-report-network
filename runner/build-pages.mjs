// Publish-side page builder. Runs in the GATED publish job on a fresh
// machine, AFTER Steve's environment approval: rebuilds the shipping pages
// deterministically from the approved draft (the reviewed artifact) using
// HEAD code and HEAD chrome from a clean checkout. Nothing the produce job's
// agent seats wrote to their own working tree is consulted, so a prompt-
// injected seat cannot smuggle a byte onto the site — the draft is the only
// input, and the draft is what Steve reviewed.
//
// Usage: node runner/build-pages.mjs <draft.md path> --genre=... --month=YYYY-MM-01 [--issue-number=NNN]
// Prints a JSON line {"written": [repo-relative paths], "canonical": ...} for
// the workflow's commit step, which commits exactly those paths.

import fs from "node:fs";
import path from "node:path";
import { buildIssueHtml, writePages, PERIOD_DIR, chromeIsIssuePage } from "./lib/pages.mjs";
import { readJson, permalinkFor } from "./lib/util.mjs";

const draftPath = process.argv[2];
const args = Object.fromEntries(
  process.argv.slice(3).map((a) => {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const genre = args.genre;
const monthDate = args.month;
if (!draftPath || !genre || !monthDate) throw new Error("usage: build-pages.mjs <draft> --genre=... --month=YYYY-MM-01");
if (!/^[a-z0-9-]+$/.test(genre)) throw new Error(`genre slug fails validation: ${genre}`);
if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(monthDate)) throw new Error(`--month must be YYYY-MM-01, got ${monthDate}`);

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const genresConfig = readJson(path.join(REPO_ROOT, "config", "genres.json"));
const genreCfg = genresConfig.genres.find((g) => g.slug === genre);
if (!genreCfg) throw new Error(`unknown genre slug ${genre}`);

const permalink = permalinkFor(genre, genreCfg.tier, monthDate);
const permPagePath = path.join(REPO_ROOT, "public", permalink.replace(/^\/|\/$/g, ""), "index.html");
if (fs.existsSync(permPagePath) && chromeIsIssuePage(fs.readFileSync(permPagePath, "utf8"))) {
  throw new Error(`permalink page ${permalink} is already a live issue page — refusing to overwrite`);
}

const genreDir = path.join(REPO_ROOT, "public", genre);
const issueNumber = String(
  args["issue-number"] ||
    fs.readdirSync(genreDir, { withFileTypes: true }).filter((e) => e.isDirectory() && PERIOD_DIR.test(e.name)).length + 1
).padStart(3, "0");

const draftText = fs.readFileSync(draftPath, "utf8");
const built = buildIssueHtml({
  draftText,
  chromeHtml: fs.readFileSync(path.join(genreDir, "index.html"), "utf8"),
  genreCfg,
  monthDate,
  issueNumber,
});
const pages = writePages({
  repoRoot: REPO_ROOT,
  genre,
  permalink,
  html: built.html,
  issueNumber,
  archLabel: built.archiveLabelUsed,
});
console.log(JSON.stringify({ written: pages.repoRelative, canonical: built.canonical, issue_number: issueNumber }));
