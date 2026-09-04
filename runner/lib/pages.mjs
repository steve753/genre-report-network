// Deterministic publisher: builds the issue page from the released draft and
// the genre's existing page chrome. Never alters report text (pipeline step 4).
// The chrome donor is the GENRE HOME — by construction the latest issue's page
// on any desk the runner is allowed to run (the runner never produces
// inaugurals, DR-0168), and deterministic where filesystem mtimes are not.

import fs from "node:fs";
import path from "node:path";
import { parseDraft, inlineMd, permalinkFor, writeFile } from "./util.mjs";

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PERIOD_DIR = /^(q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{4}$/;

// A real issue page (vs a pre-launch placeholder) carries EVERYTHING the
// build consumes: the utility topbar, the issue title block, the offer card,
// the bottom CTA, the disclosure footer, and the archive anchor. Testing the
// full contract here means a desk that cannot build is skipped at prepare
// (zero seat spend) instead of failing after a full production.
export function chromeIsIssuePage(html) {
  return (
    html.includes('class="topbar"') &&
    html.includes('class="title"') &&
    html.includes('<aside class="offer"') &&
    html.includes('<div class="bottomcta">') &&
    html.includes("</details>") &&
    html.includes('<option value="">Archive</option>')
  );
}

// Figure blocks pass through to the page VERBATIM, so they are the one HTML
// channel a draft carries, and the draft is authored by seats that fetch
// untrusted web content. The contract is STRICT SYNTAX + ALLOWLIST: rather
// than trying to parse hostile HTML the way a browser would, anything the
// strict grammar cannot account for is REFUSED — ambiguity becomes refusal,
// never a guess. Every attribute must be double-quoted (name="value") or a
// bare name; every < must open a valid tag, a closing tag, or a comment;
// backslashes are banned in CSS; style selectors must stay chart-scoped.
// All live desk figures satisfy every rule. A refusal surfaces through
// validateDraft, where the writer-repair pass fixes it for one seat-call.
const FIGURE_ALLOWED_ELEMENTS = new Set([
  "figure", "figcaption", "svg", "title", "desc", "style", "defs", "pattern",
  "g", "path", "rect", "line", "circle", "ellipse", "polyline", "polygon",
  "text", "tspan", "strong", "em", "span", "div", "p", "table", "thead",
  "tbody", "tr", "th", "td",
]);
const ATTR_STRICT = /^(?:\s+[a-zA-Z][\w:-]*(?:="[^"<>]*")?)*\s*\/?$/;
const ATTR_PAIR = /([a-zA-Z][\w:-]*)(?:="([^"<>]*)")?/g;

function checkFigureCss(css, where) {
  const banned = css.match(/@import|url\s*\(|expression\s*\(|javascript\s*:|\\/i);
  if (banned) throw new Error(`figure ${where} contains forbidden CSS: "${banned[0]}"`);
}

export function assertFigureSafe(figureHtml) {
  // Comments are the one construct whose boundaries a regex cannot express
  // the way a browser does (<!-->, --!>, <!---> all close early). Ambiguity
  // becomes refusal: no comments or declarations in figures, full stop.
  if (figureHtml.includes("<!")) {
    throw new Error("figure block contains a comment or declaration (<!) — not permitted; write &lt; for a literal less-than");
  }
  const src = figureHtml;

  // every "<" must start a tag this grammar fully accounts for
  let i = 0;
  const styleOpens = [];
  while ((i = src.indexOf("<", i)) !== -1) {
    const rest = src.slice(i);
    const m = rest.match(/^<(\/?)([a-zA-Z][\w:-]*)((?:[^>"]|"[^"<>]*")*)>/);
    if (!m) {
      throw new Error(
        `figure block contains a "<" that does not open a valid tag (write &lt; for a literal less-than): ...${src.slice(i, i + 40)}...`
      );
    }
    const [whole, closing, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (!FIGURE_ALLOWED_ELEMENTS.has(name)) {
      throw new Error(`figure block contains a non-allowlisted element: <${closing}${rawName}>`);
    }
    if (closing && attrs.trim() !== "") throw new Error(`figure closing tag </${rawName}> carries attributes`);
    if (!closing) {
      if (!ATTR_STRICT.test(attrs)) {
        throw new Error(
          `figure element <${rawName}> has attributes outside the strict name="value" grammar (single quotes, unquoted values, and stray characters are refused): ${attrs.trim().slice(0, 60)}`
        );
      }
      let pair;
      ATTR_PAIR.lastIndex = 0;
      while ((pair = ATTR_PAIR.exec(attrs)) !== null) {
        const attr = pair[1].toLowerCase();
        if (/^on/.test(attr) || ["href", "xlink:href", "src", "srcdoc", "formaction", "xml:base"].includes(attr)) {
          throw new Error(`figure element <${rawName}> carries a forbidden attribute: ${pair[1]}`);
        }
        if (attr === "style") checkFigureCss(pair[2] || "", `element <${rawName}> style attribute`);
      }
      if (name === "style") styleOpens.push(i);
    }
    i += whole.length;
  }

  // style bodies: must be terminated, CSS-banned content, chart-scoped selectors
  for (const rcdata of ["style", "title"]) {
    const blocks = src.match(new RegExp(`<${rcdata}\\b[^>]*>[\\s\\S]*?<\\/${rcdata}\\s*>`, "gi")) || [];
    const opens = (src.match(new RegExp(`<${rcdata}\\b`, "gi")) || []).length;
    if (opens !== blocks.length) throw new Error(`figure block contains an unterminated <${rcdata}> element`);
  }
  const styleBlocks = src.match(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi) || [];
  for (const st of styleBlocks) {
    const body = st.replace(/^<style\b[^>]*>/i, "").replace(/<\/style\s*>$/i, "");
    checkFigureCss(body, "<style> body");
    // Every selector — INCLUDING those nested inside @media — must anchor a
    // compound on the chart itself: svg/figure/figcaption or a .ch* class at
    // the HEAD of a compound (":not(svg) body" does not count). @media is the
    // only at-rule permitted to wrap rules.
    //
    // A "}" inside a CSS comment or string is not a block terminator; blank
    // both out (single left-to-right pass, so string-vs-comment precedence
    // matches the CSS tokenizer) before segmenting, or "/*}*/" hides the real
    // selector from the scan. checkFigureCss above ran on the RAW body, so
    // url(/backslash hidden inside a comment stays refused. CSS Syntax §3.3
    // preprocesses CR, FF and CRLF to LF before tokenizing, so all three
    // terminate a string exactly as \n does — exclude the whole set, or a
    // form feed blanks a region the browser reads as real top-level CSS.
    // Anything still unterminated after blanking is ambiguous: refuse it.
    const scan = body.replace(/\/\*[\s\S]*?\*\/|"[^"\n\r\f]*"|'[^'\n\r\f]*'/g, (t) => (t[0] === "/" ? " " : "_"));
    if (/\/\*|["']/.test(scan)) throw new Error("figure <style> contains an unterminated CSS comment or string");
    const segs = scan.split("{");
    for (let k = 0; k < segs.length - 1; k++) {
      const sel = segs[k].slice(segs[k].lastIndexOf("}") + 1).trim();
      if (!sel) continue;
      if (/^@media\b/i.test(sel)) continue;
      if (sel.startsWith("@")) throw new Error(`figure <style> uses an unsupported at-rule: "${sel}"`);
      // Sibling/adjacent combinators reach OUT of the figure (a figure-anchored
      // compound can still select the report copy that follows it). The chart
      // dialect needs only descendant and comma forms — refuse ~ and + in
      // selector position outright. (String contents were blanked above, so a
      // "+" inside an attribute string cannot false-positive here.)
      if (/[~+]/.test(sel)) throw new Error(`figure <style> selector uses a sibling/adjacent combinator: "${sel.trim()}"`);
      for (const one of sel.split(",")) {
        const t = one.trim();
        if (!t) continue;
        const compounds = t.split(/[\s>]+/).filter(Boolean);
        if (!compounds.some((c) => /^(svg|figure|figcaption)\b/i.test(c) || /^\.ch[a-z]/i.test(c))) {
          throw new Error(`figure <style> selector escapes the chart scope: "${t}"`);
        }
      }
    }
  }
}

// Split the draft body into sections on "## LABEL: Heading" lines. The writer
// contract requires every section heading to carry an UPPERCASE label ending
// in a colon. Content inside <figure>...</figure> passes through verbatim.
export function splitSections(body) {
  const parts = body.split(/^## /m).slice(1);
  return parts.map((part) => {
    const nl = part.indexOf("\n");
    const heading = part.slice(0, nl).trim();
    const m = heading.match(/^([A-Z0-9 &'’-]+):\s+(.+)$/);
    if (!m) throw new Error(`section heading missing "LABEL: Title" shape: "${heading}"`);
    return { label: m[1], title: m[2], content: part.slice(nl + 1).trim() };
  });
}

// Validate the draft against everything the pipeline needs DOWNSTREAM —
// run this immediately after the writer seat (and after every fixes pass),
// so structural failures cost zero further seat spend and the write lane's
// gates (subject present, 3–6 non-empty teasers) can never first fire after
// a deploy.
export function validateDraft(draftText) {
  const { frontmatter: fm, body } = parseDraft(draftText);
  const problems = [];
  for (const k of ["kicker", "title", "lede", "meta_description", "sources_footer", "email_subject"]) {
    if (!fm[k] || (typeof fm[k] === "string" && !fm[k].trim())) problems.push(`missing frontmatter field: ${k}`);
  }
  for (const fig of body.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/g) || []) {
    try {
      assertFigureSafe(fig);
    } catch (e) {
      problems.push(e.message);
    }
  }
  const tb = fm.teaser_bullets;
  if (!Array.isArray(tb) || tb.length < 3 || tb.length > 6 || tb.some((t) => !t || !t.trim())) {
    problems.push(`teaser_bullets must be 3-6 non-empty entries (got ${Array.isArray(tb) ? tb.length : typeof tb})`);
  }
  if (!Array.isArray(fm.stories) || fm.stories.length === 0) problems.push("stories list missing or empty");
  try {
    const sections = splitSections(body);
    if (sections.length < 3) problems.push(`only ${sections.length} sections`);
  } catch (e) {
    problems.push(e.message);
  }
  return { ok: problems.length === 0, problems, frontmatter: fm };
}

function renderBlocks(content, figClass) {
  const out = [];
  // preserve <figure> blocks verbatim (any attributes); everything else is draft-dialect markdown
  const chunks = content.split(/(<figure\b[^>]*>[\s\S]*?<\/figure>)/);
  for (const chunk of chunks) {
    if (/^<figure\b/.test(chunk)) {
      assertFigureSafe(chunk);
      out.push(chunk.replace(/^<figure\b[^>]*>/, `<figure class="${figClass}">`));
      continue;
    }
    for (const para of chunk.split(/\n\n+/)) {
      const p = para.trim();
      if (!p || p === "---") continue;
      out.push(`    <p>${inlineMd(p).replace(/\n/g, " ")}</p>`);
    }
  }
  return out.join("\n");
}

export function buildIssueHtml({ draftText, chromeHtml, genreCfg, monthDate, issueNumber }) {
  const genre = genreCfg.slug;
  const tier = genreCfg.tier;
  const { frontmatter: fm, body } = parseDraft(draftText);
  const v = validateDraft(draftText);
  if (!v.ok) throw new Error(`draft invalid: ${v.problems.join("; ")}`);
  const permalink = permalinkFor(genre, tier, monthDate);
  const canonical = `https://reports.stevepieper.com${permalink}`;
  const sections = splitSections(body);

  // The donor may carry its own permanent-edition footer line — strip it so
  // neither the new permalink page nor the genre home inherits a stale one.
  const cleanChrome = chromeHtml.replace(/\n?[ \t]*<p>This is the permanent edition[\s\S]*?<\/p>/g, "");

  const chrome = extractChrome(cleanChrome);
  // The figure panel class differs across desk chromes (thriller/fantasy
  // style figure.slotshare; mystery/romance style figure.databox) — take
  // whichever this donor actually styles, and refuse a donor that styles
  // neither rather than shipping unstyled data boxes.
  const figClass = /figure\.databox\s*\{/.test(cleanChrome)
    ? "databox"
    : /figure\.slotshare\s*\{/.test(cleanChrome)
      ? "slotshare"
      : null;
  if (!figClass && /<figure\b/.test(body)) {
    throw new Error("chrome styles neither figure.databox nor figure.slotshare — figures would ship unstyled");
  }
  const rendered = [];
  sections.forEach((sec, i) => {
    rendered.push(
      `  <section id="s${i + 1}">\n` +
        `    <h2><span class="sec">${esc(sec.label)}:</span> ${inlineMd(sec.title)}</h2>\n` +
        renderBlocks(sec.content, figClass) +
        `\n  </section>`
    );
    if (i === 1) rendered.push(chrome.offerCard);
  });

  const main = [
    `<main>`,
    `  <p class="fromdesk">from the desk of Steve Pieper, Polymath Consulting &amp; Publishing.</p>`,
    `  <p class="kicker">${esc(fm.kicker)}</p>`,
    `  <h1 class="title">${inlineMd(fm.title)}</h1>`,
    ``,
    `  <p class="lede">${inlineMd(fm.lede)}</p>`,
    ``,
    rendered.join("\n\n"),
    ``,
    `  <p class="src"><em>${inlineMd(fm.sources_footer)}</em></p>`,
    ``,
    chrome.bottomCta,
    `</main>`,
  ].join("\n");

  let html = cleanChrome.replace(/<main>[\s\S]*<\/main>/, () => main);
  const titleTag = fm.title_tag || defaultTitleTag(genreCfg, issueNumber, monthDate);
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(titleTag)}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(fm.meta_description)}">`);
  html = html.replace(/<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${canonical}">`);
  html = html.replace(/consent_source:\s*'[^']*'/, () => `consent_source: '${genre}-issue-${issueNumber}'`);
  const archiveLabelUsed = fm.archive_label || archiveLabel(tier, monthDate, issueNumber);
  html = addArchiveOption(html, permalink, archiveLabelUsed);
  if (!html.includes(`value="${permalink}"`)) {
    throw new Error("archive anchor missing from the chrome — the new page would ship without its own archive entry");
  }
  return { html, permalink, canonical, frontmatter: fm, archiveLabelUsed };
}

export function defaultTitleTag(genreCfg, issueNumber, monthDate) {
  const cadence = genreCfg.tier === "monthly" ? "Monthly" : "Quarterly";
  return `${genreCfg.display_name} ${cadence} — Issue ${issueNumber} · ${periodLabel(genreCfg.tier, monthDate, "long")}`;
}

function periodLabel(tier, monthDate, style) {
  const [y, m] = monthDate.split("-").map(Number);
  if (tier === "monthly") {
    const month = new Date(Date.UTC(y, m - 1)).toLocaleString("en-US", { month: style, timeZone: "UTC" });
    return `${month} ${y}`;
  }
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

function archiveLabel(tier, monthDate, issueNumber) {
  // Live convention: "September 2026 — Issue 002" (full month name)
  return `${periodLabel(tier, monthDate, "long")} — Issue ${issueNumber}`;
}

function extractChrome(chromeHtml) {
  const offer = chromeHtml.match(/<aside class="offer"[\s\S]*?<\/aside>/);
  const cta = chromeHtml.match(/<div class="bottomcta">[\s\S]*?<\/div>/);
  const topbar = chromeHtml.includes('class="topbar"');
  if (!offer || !cta) throw new Error("chrome donor page lacks offer card or bottom CTA");
  if (!topbar) {
    throw new Error(
      "genre home is not an issue page (no topbar) — this desk has no published issue yet; the runner only produces recurring cycles (DR-0168)"
    );
  }
  return { offerCard: "  " + offer[0], bottomCta: "  " + cta[0] };
}

// Insert the new permalink at the top of the archive <select>, once, on any
// page whose dropdown lacks it.
export function addArchiveOption(html, permalink, label) {
  if (html.includes(`value="${permalink}"`)) return html;
  return html.replace(
    /(<option value="">Archive<\/option>\n)/,
    () => `<option value="">Archive</option>\n    <option value="${permalink}">${esc(label)}</option>\n`
  );
}

// Write the permanent edition and the genre-home flip (home = same page minus
// the permanent-edition footer line; ruled by .publish_visibility that pages
// go live on deploy). Also update archive dropdowns on prior permalinks.
export function writePages({ repoRoot, genre, permalink, html, issueNumber, archLabel }) {
  const permDir = path.join(repoRoot, "public", permalink.replace(/^\/|\/$/g, ""));
  const visible = `reports.stevepieper.com${permalink}`;
  const permanentLine = `  <p>This is the permanent edition of Issue ${issueNumber} · <a href="${permalink}">${visible}</a></p>\n`;
  const withLine = html.replace(/(<\/details>\n)/, () => `</details>\n${permanentLine}`);
  if (withLine === html) throw new Error("could not insert the permanent-edition line (no </details> in footer)");
  const repoRelative = [];
  writeFile(path.join(permDir, "index.html"), withLine);
  repoRelative.push(path.relative(repoRoot, path.join(permDir, "index.html")));
  writeFile(path.join(repoRoot, "public", genre, "index.html"), html);
  repoRelative.push(path.join("public", genre, "index.html"));
  // prior permalinks: archive dropdown only, content otherwise untouched
  const genreDir = path.join(repoRoot, "public", genre);
  const touched = [];
  for (const entry of fs.readdirSync(genreDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PERIOD_DIR.test(entry.name)) continue;
    const p = path.join(genreDir, entry.name, "index.html");
    if (!fs.existsSync(p) || path.join(genreDir, entry.name) === permDir) continue;
    const before = fs.readFileSync(p, "utf8");
    const after = addArchiveOption(before, permalink, archLabel);
    if (after !== before) {
      fs.writeFileSync(p, after);
      touched.push(p);
      repoRelative.push(path.relative(repoRoot, p));
    }
  }
  return { permanentPath: path.join(permDir, "index.html"), touched, repoRelative };
}

export { PERIOD_DIR };
