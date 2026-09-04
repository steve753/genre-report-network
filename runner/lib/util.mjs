// Shared helpers for the production runner. No credentials in this file.

import fs from "node:fs";
import path from "node:path";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required environment variable ${name}`);
  return v.trim();
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

// Issue addressing. Monthly desks use /{genre}/{mmm}-{yyyy}/; quarterly desks /{genre}/q{Q}-{yyyy}/.
// monthDate is "YYYY-MM-01" (the issues.month column value).
export function permalinkFor(genre, tier, monthDate) {
  const [y, m] = monthDate.split("-").map(Number);
  if (tier === "monthly") return `/${genre}/${MONTHS[m - 1]}-${y}/`;
  const q = Math.floor((m - 1) / 3) + 1;
  return `/${genre}/q${q}-${y}/`;
}

// Which genres are due for a given month under the ruled cadence
// (genre_reports.network.cadence): monthly every month, quarterly on
// quarter starts (Jan/Apr/Jul/Oct).
export function genresDue(genresConfig, monthDate) {
  const m = Number(monthDate.split("-")[1]);
  const quarterStart = [1, 4, 7, 10].includes(m);
  return genresConfig.genres
    .filter((g) => g.tier === "monthly" || (g.tier === "quarterly" && quarterStart))
    .map((g) => g.slug);
}

export function currentMonthDate(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

// Parse the adversary's verdict line. The adversary brief REQUIRES the exact
// shape ON THE FIRST TWO LINES of the report:
//   VERDICT: RELEASE|REVISE|REJECT
//   Counts: N severity-1 · N severity-2 · N severity-3
// Only the report's first five lines are consulted, so body text quoting the
// format cannot flip the outcome. Unparseable = REJECT — fail closed.
export function parseVerdict(reportText) {
  const head = reportText.split("\n").slice(0, 5).join("\n");
  const v = head.match(/VERDICT:\s*\**\s*(RELEASE|REVISE|REJECT)/i);
  const c = head.match(/Counts?:\s*\**\s*(\d+)\s*severity-1\s*[·,]\s*(\d+)\s*severity-2\s*[·,]\s*(\d+)\s*severity-3/i);
  if (!v) return { verdict: "REJECT", sev1: null, sev2: null, sev3: null, parsed: false };
  return {
    verdict: v[1].toUpperCase(),
    sev1: c ? Number(c[1]) : null,
    sev2: c ? Number(c[2]) : null,
    sev3: c ? Number(c[3]) : null,
    parsed: Boolean(v && c),
  };
}

// Split a draft into YAML-ish frontmatter and body. The writer's contract
// (prompts/writer.md) keeps frontmatter simple: scalar lines and one-level
// "- " lists. This is not a general YAML parser and must not become one.
export function parseDraft(draftText) {
  const m = draftText.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("draft has no frontmatter block");
  const fm = {};
  let currentList = null;
  for (const line of m[1].split("\n")) {
    const list = line.match(/^\s*-\s+(.*)$/); // column-0 lists are legal too
    if (list && currentList) {
      fm[currentList].push(list[1].trim());
      continue;
    }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) {
      if (kv[2] === "") {
        currentList = kv[1];
        fm[kv[1]] = [];
      } else {
        currentList = null;
        fm[kv[1]] = kv[2].trim();
      }
    }
  }
  return { frontmatter: fm, body: m[2] };
}

// Markdown-to-HTML for the draft dialect ONLY: paragraphs, **bold**, *em*,
// [text](url) links, and passthrough <figure>...</figure> blocks. Headings are
// handled by the section splitter, not here. Ampersands and angle brackets in
// prose are escaped; the draft dialect forbids raw HTML outside <figure>.
export function inlineMd(text) {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // links first (their URLs must not be entity-escaped further)
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, "%22")}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return s;
}

// The publish gate's single predicate: a summary is shippable only when the
// seats phase declared success AND a send payload exists. The workflow's gate
// step and the tests import THIS function, so they cannot drift apart.
export function shippableSummary(s) {
  return Boolean(s && s.ok === true && s.send_payload && s.send_payload.subject);
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
