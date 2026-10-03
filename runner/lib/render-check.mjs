// Render the built issue page in the runner's own Chrome, MEASURE it, and save
// full-length screenshots as readable tiles.
//
// Why this replaced screenshot.sh (2026-10-03): the old script took fixed
// 1100x12000 and 430x12000 windows. Thriller Issue 003 is 19,805 px tall on a
// desktop and 33,281 px on a phone, so the lower half of the page was never
// captured -- and the layout seat still reported a footer it could not have
// seen. A model reading pictures is a second opinion, not the control. The
// control is here, in code: layoutVerdict() FAILS the run on the structural
// faults a reader would notice. The seat still reads every tile, and a fault
// it can see FAILS the run even when the code passed.
//
// No npm dependency: Chrome is driven over --remote-debugging-pipe (the
// DevTools protocol on file descriptors 3 and 4), so the runner's self-tests,
// which deploy.yml runs with no install step, never need a browser package.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

export const VIEWPORTS = [
  { name: "desktop", width: 1100, tileHeight: 1400, mobile: false },
  { name: "mobile", width: 430, tileHeight: 1400, mobile: true },
];
export const MAX_PAGE_HEIGHT = 100000; // px; a page taller than this is broken, not long
const LOAD_TIMEOUT_MS = 45000;
const SEND_TIMEOUT_MS = 30000; // any single DevTools request
export const RENDER_DEADLINE_MS = 180000; // the whole check; past this Chrome is killed and the run fails hard

// ---- the verdict: pure, so run-tests.mjs checks it with no browser ----

// measurements: { desktop: <measure()>, mobile: <measure()> }
// returns { pass, failures: [string], summary: [string] }
export function layoutVerdict(measurements) {
  const failures = [];
  const summary = [];
  for (const vp of VIEWPORTS) {
    const m = measurements?.[vp.name];
    if (!m) { failures.push(`${vp.name}: page was not measured`); continue; }
    const at = `${vp.name} (${vp.width} px wide)`;
    summary.push(`${at}: page ${Math.round(m.pageHeight)} px tall, ${m.h2} section headings, ${m.figures.length} figure(s), footer ${m.footer ? `${m.footer.textLength} characters` : "absent"}`);
    if (!(m.pageHeight > 0)) failures.push(`${at}: page has no height`);
    if (m.pageHeight > MAX_PAGE_HEIGHT) failures.push(`${at}: page is ${Math.round(m.pageHeight)} px tall, over the ${MAX_PAGE_HEIGHT} px limit`);
    // Compare with the width we set, never the page's own window width: a
    // phone browser zooms a too-wide page out until it "fits", which makes
    // window and content agree while every word shrinks.
    if (m.viewportWidth > vp.width + 1) failures.push(`${at}: the browser zoomed out to a ${m.viewportWidth} px layout to fit the content -- the page is too wide for this screen`);
    if (m.scrollWidth > vp.width + 1) failures.push(`${at}: page scrolls sideways (content ${m.scrollWidth} px wide in a ${vp.width} px window)`);
    if (!m.masthead) failures.push(`${at}: no masthead visible on the page`);
    if (m.h1 < 1) failures.push(`${at}: no visible headline`);
    if (m.h2 < 3) failures.push(`${at}: ${m.h2} visible section heading(s) in the article, fewer than three`);
    if (!m.footer || !m.footer.visible || m.footer.textLength < 20) failures.push(`${at}: footer missing, hidden, off the page or empty`);
    if (m.brokenImages.length) failures.push(`${at}: broken image(s): ${m.brokenImages.join(", ")}`);
    for (const f of m.figures) {
      const fig = `${at}: figure ${f.index + 1}`;
      if (f.w < 50 || f.h < 50) failures.push(`${fig} renders at ${Math.round(f.w)}x${Math.round(f.h)} px`);
      if (f.right > vp.width + 1) failures.push(`${fig} runs off the right edge of the screen (right edge at ${Math.round(f.right)} px)`);
      if (f.hasSvg) {
        if (f.textsOutside.length) failures.push(`${fig}: chart text outside the chart frame: ${f.textsOutside.map((t) => JSON.stringify(t)).join(", ")}`);
        if (f.textOverlaps.length) failures.push(`${fig}: chart labels overlap: ${f.textOverlaps.map(([a, b]) => `${JSON.stringify(a)} on ${JSON.stringify(b)}`).join("; ")}`);
        if (f.rotatedTexts > 0) summary.push(`${fig}: ${f.rotatedTexts} tilted label(s): checked against the frame, overlap left to the layout seat`);
        if (f.unstyledBlackMarks > 0) failures.push(`${fig}: ${f.unstyledBlackMarks} chart mark(s) drew in default black -- their color rules did not apply (the Issue 003 fault)`);
      }
    }
  }
  return { pass: failures.length === 0, failures, summary };
}

export function verdictMarkdown(v) {
  return [
    "# Mechanical layout check (code, not a model)",
    "",
    ...v.summary.map((s) => `- ${s}`),
    "",
    ...(v.failures.length ? ["Failures:", ...v.failures.map((f) => `- ${f}`), ""] : []),
    v.pass ? "MECHANICAL: PASS" : `MECHANICAL: FAIL — ${v.failures.length} problem(s), listed above`,
    "",
  ].join("\n");
}

// ---- the in-page measurement (runs inside Chrome) ----

export const MEASURE_SOURCE = String.raw`(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const out = {
    viewportWidth: vw,
    scrollWidth: de.scrollWidth,
    pageHeight: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };
  // On the page horizontally, where a reader can scroll to it: an element
  // pushed far off an edge still has a size, so "visible" alone would pass it.
  const onPage = (el) => { if (!visible(el)) return false; const r = el.getBoundingClientRect(); return r.right + window.scrollX > 0 && r.left + window.scrollX < de.scrollWidth; };
  out.masthead = onPage(document.querySelector("header.masthead"));
  out.h1 = [...document.querySelectorAll("h1")].filter(visible).length;
  out.h2 = [...document.querySelectorAll("main h2")].filter(visible).length;
  const f = document.querySelector("footer");
  out.footer = f ? { visible: onPage(f), textLength: f.innerText.trim().length } : null;
  out.brokenImages = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src") || "(no src)");
  // Every figure on the page, not only those in <main>: a figure the chrome
  // moved elsewhere must not skip the chart checks.
  const fillRules = [];
  const collect = (rules) => {
    for (const r of rules || []) {
      if (r.cssRules) collect(r.cssRules);
      if (r.selectorText && r.style && r.style.getPropertyValue("fill")) fillRules.push({ sel: r.selectorText, fill: r.style.getPropertyValue("fill") });
    }
  };
  for (const sh of document.styleSheets) { try { collect(sh.cssRules); } catch (e) { /* cross-origin sheet: unreadable, skipped */ } }
  const saysBlack = (v) => /^(#000(000)?|black|rgb\(0,\s*0,\s*0\))$/i.test((v || "").trim());
  out.figures = [...document.querySelectorAll("figure")].map((fig, index) => {
    const fr = fig.getBoundingClientRect();
    const res = { index, w: fr.width, h: fr.height, right: fr.right + window.scrollX, hasSvg: false, textsOutside: [], textOverlaps: [], rotatedTexts: 0, unstyledBlackMarks: 0 };
    const svg = fig.querySelector("svg");
    if (!svg) return res;
    res.hasSvg = true;
    const sr = svg.getBoundingClientRect();
    // Rotated or skewed labels (tilted axis ticks) have screen boxes far larger
    // than their ink, so box tests would fail sound charts. They are counted,
    // left out of the box tests, and left to the layout seat's eyes.
    const straight = (t) => { const c = t.getScreenCTM(); return !c || (Math.abs(c.b) < 1e-6 && Math.abs(c.c) < 1e-6); };
    const shown = [...svg.querySelectorAll("text")].filter((t) => t.textContent.trim() && visible(t));
    const tilted = shown.filter((t) => !straight(t));
    res.rotatedTexts = tilted.length;
    // A tilted label is still tested against the frame, exactly: the four
    // corners of its own box, mapped to the screen, must lie inside the frame.
    // (Overlap between tilted labels stays with the seat.)
    const tiltedOutside = tilted.filter((t) => {
      try {
        const bb = t.getBBox(); const c = t.getScreenCTM();
        return [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
          .map(([x, y]) => new DOMPoint(x, y).matrixTransform(c))
          .some((q) => q.x < sr.left - 2 || q.x > sr.right + 2 || q.y < sr.top - 2 || q.y > sr.bottom + 2);
      } catch (x) { return false; }
    }).map((t) => t.textContent.trim().slice(0, 40));
    const texts = shown.filter(straight)
      .map((t) => { const r = t.getBoundingClientRect(); return { t: t.textContent.trim().slice(0, 40), l: r.left, r: r.right, tp: r.top, b: r.bottom }; });
    res.textsOutside = [...texts.filter((t) => t.l < sr.left - 2 || t.r > sr.right + 2 || t.tp < sr.top - 2 || t.b > sr.bottom + 2).map((t) => t.t), ...tiltedOutside].slice(0, 10);
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b, b.b) - Math.max(a.tp, b.tp);
      if (ox > 2 && oy > 2 && res.textOverlaps.length < 10) res.textOverlaps.push([a.t, b.t]);
    }
    // A mark counts as "lost its color" when it computes to SVG's default
    // black, actually paints an area (a straight line segment has no fill to
    // see), and nothing on it or its ancestors -- attribute, inline style or a
    // matching stylesheet rule -- asked for black.
    const askedForBlack = (el) => {
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        if (saysBlack(e.getAttribute("fill")) || saysBlack(e.style && e.style.fill)) return true;
        for (const r of fillRules) { if (!saysBlack(r.fill)) continue; try { if (e.matches(r.sel)) return true; } catch (x) { /* selector the engine cannot test */ } }
        if (e === svg) break;
      }
      return false;
    };
    const paintsArea = (m) => {
      try {
        const bb = m.getBBox();
        if (!(bb.width > 0 && bb.height > 0)) return false;
        // Uneven sample fractions: no x fraction equals a y fraction and no
        // pair sums to 1, so no sample lies on either diagonal of the box --
        // a point exactly on a straight segment counts as "in" its fill.
        for (const fx of [0.13, 0.31, 0.52, 0.71, 0.88]) for (const fy of [0.17, 0.36, 0.58, 0.77, 0.94]) {
          if (m.isPointInFill(new DOMPoint(bb.x + bb.width * fx, bb.y + bb.height * fy))) return true;
        }
        return false;
      } catch (x) { return true; }
    };
    for (const m of svg.querySelectorAll("rect, path, circle, polygon, polyline, ellipse")) {
      if (!visible(m)) continue;
      if (getComputedStyle(m).fill !== "rgb(0, 0, 0)") continue;
      if (!paintsArea(m)) continue;
      if (askedForBlack(m)) continue;
      res.unstyledBlackMarks++;
    }
    return res;
  });
  return out;
})()`;

// ---- Chrome over the DevTools pipe ----

// Absolute locations only, never a PATH search: earlier seats run Bash in this
// job, and a PATH directory they can write must not be able to supply "Chrome".
export function findChrome() {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium"];
  for (const c of candidates) if (c && path.isAbsolute(c) && fs.existsSync(c)) return c;
  throw new Error("no Chrome or Chromium found for the render check (set CHROME_PATH to an absolute path)");
}

function cdp(chrome) {
  const proc = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let stderr = "";
  let dead = null; // the reason Chrome is unusable, once it is
  const pending = new Map();
  const listeners = [];
  const die = (why) => {
    if (dead) return;
    dead = why;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`render check: Chrome is unusable (${why})${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`)); }
    pending.clear();
  };
  // Every failure Chrome can produce becomes a rejected request, never an
  // uncaught error that kills the process before the run's own error handling
  // (and its K-lytics containment guard) can run.
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  proc.on("error", (e) => { die(`could not start: ${e.message}`); resolveExit(null); });
  proc.on("exit", (code, sig) => { die(`exited (${code ?? sig})`); resolveExit(code); });
  for (const st of [proc.stdio[2], proc.stdio[3], proc.stdio[4]]) st?.on("error", (e) => die(`pipe error: ${e.message}`));
  proc.stdio[2]?.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  let buf = Buffer.alloc(0);
  proc.stdio[4]?.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let z;
    while ((z = buf.indexOf(0)) !== -1) {
      let msg;
      try { msg = JSON.parse(buf.subarray(0, z).toString("utf8")); } catch { die("unreadable reply on the DevTools pipe"); return; }
      buf = buf.subarray(z + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        msg.error ? reject(new Error(`render check: ${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of [...listeners]) l(msg);
      }
    }
  });
  let nextId = 1;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(`render check: Chrome is unusable (${dead})`)); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`render check: no answer to ${method} within ${SEND_TIMEOUT_MS / 1000} s`)); }, SEND_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try { proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); } catch (e) { die(`write failed: ${e.message}`); }
  });
  const once = (method, sessionId, ms) => new Promise((resolve, reject) => {
    const l = (msg) => { if (msg.method === method && msg.sessionId === sessionId) { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); resolve(msg.params); } };
    const t = setTimeout(() => { listeners.splice(listeners.indexOf(l), 1); reject(new Error(`render check: timed out after ${ms / 1000} s waiting for ${method}`)); }, ms);
    listeners.push(l);
  });
  const close = async () => {
    if (!dead) { try { await Promise.race([send("Browser.close"), new Promise((r) => setTimeout(r, 3000))]); } catch { /* closing anyway */ } }
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    // A grandchild that inherited the pipes can outlive the kill; let go of
    // them so a stalled Chrome can never keep this process from exiting.
    for (const st of proc.stdio) { try { st?.destroy(); } catch { /* closed */ } }
    proc.unref();
  };
  return { send, once, close };
}

function serve(publicRoot) {
  const root = path.resolve(publicRoot);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
    let file = path.resolve(root, "." + p);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Renders <rel> from <publicRoot> at each viewport, writes tiles
// page-<viewport>-NN.png and layout-mechanical.md into outDir, and returns
// { verdict, measurements, tiles }. Throws only when the page could not be
// rendered at all -- a hard error, never a pass.
export async function renderCheck({ publicRoot, rel, outDir, chromePath, deadlineMs = RENDER_DEADLINE_MS } = {}) {
  if (!/^\/[a-z0-9/-]*\/$/.test(rel)) throw new Error(`render check: unexpected page path ${rel}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/^page-.*\.png$/.test(f)) fs.rmSync(path.join(outDir, f));
  const server = await serve(publicRoot);
  const url = `http://127.0.0.1:${server.address().port}${rel}`;
  const browser = cdp(chromePath || findChrome());
  const measurements = {};
  const tiles = [];
  let deadlineTimer;
  const deadline = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error(`render check: not finished within ${deadlineMs / 1000} s`)), deadlineMs); });
  const work = (async () => {
    for (const vp of VIEWPORTS) {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m, p) => browser.send(m, p, sessionId);
      await s("Page.enable");
      await s("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.tileHeight, deviceScaleFactor: 1, mobile: vp.mobile });
      const loaded = browser.once("Page.loadEventFired", sessionId, LOAD_TIMEOUT_MS);
      const nav = await s("Page.navigate", { url });
      if (nav.errorText) throw new Error(`render check: ${url} failed to load (${nav.errorText})`);
      await loaded;
      await s("Runtime.evaluate", { expression: "document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))", awaitPromise: true });
      const ev = await s("Runtime.evaluate", { expression: MEASURE_SOURCE, returnByValue: true });
      if (ev.exceptionDetails) throw new Error(`render check: measurement script failed: ${ev.exceptionDetails.text}`);
      const m = ev.result.value;
      measurements[vp.name] = m;
      const height = Math.min(Math.ceil(m.pageHeight), MAX_PAGE_HEIGHT);
      const count = Math.max(1, Math.ceil(height / vp.tileHeight));
      for (let i = 0; i < count; i++) {
        const y = i * vp.tileHeight;
        const h = Math.min(vp.tileHeight, height - y);
        const shot = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: vp.width, height: h, scale: 1 } });
        const name = `page-${vp.name}-${String(i + 1).padStart(2, "0")}.png`;
        fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, "base64"));
        tiles.push(name);
      }
      await browser.send("Target.closeTarget", { targetId });
    }
  })();
  work.catch(() => { /* reported through the race below */ });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  const verdict = layoutVerdict(measurements);
  fs.writeFileSync(path.join(outDir, "layout-mechanical.md"), verdictMarkdown(verdict) + `\nTiles, top to bottom: ${tiles.join(", ")}\n`);
  fs.writeFileSync(path.join(outDir, "layout-mechanical.json"), JSON.stringify({ verdict, measurements, tiles }, null, 2));
  return { verdict, measurements, tiles };
}

// CLI for a local look: node runner/lib/render-check.mjs <public-root> <page-path> <out-dir>
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [publicRoot, rel, outDir] = process.argv.slice(2);
  renderCheck({ publicRoot, rel, outDir }).then(({ verdict, tiles }) => {
    console.log(verdictMarkdown(verdict));
    console.log(`${tiles.length} tiles written to ${outDir}`);
    process.exit(verdict.pass ? 0 : 2);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
