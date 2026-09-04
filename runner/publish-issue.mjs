// Post-deploy publication step, run by the gated publish job AFTER Steve's
// GitHub environment approval and a green deploy: smoke-test the live pages,
// record publication through the genre write lane (DR-0166 — the lane's
// Postgres gates are the authority, this is just transport), then call the
// credential-free notify endpoint so Steve gets the one-click review email
// (DR-0165). This process cannot approve, arm, or send — those capabilities
// have no surface here by design.

import fs from "node:fs";
import { requireEnv, log } from "./lib/util.mjs";
import { upsertDraftIssue } from "./lib/pack.mjs";

const summary = JSON.parse(fs.readFileSync(process.argv[2] || "summary.json", "utf8"));
if (!summary.ok || !summary.send_payload || !summary.send_payload.subject) {
  throw new Error("summary.json is not a released issue with a send payload");
}


// ---- 1. Smoke test the live pages (real assertions, not presence-of-CSS) ----
const permalinkPath = new URL(summary.permalink).pathname;
const permRes = await fetch(summary.permalink);
const permBody = await permRes.text();
if (!permRes.ok) throw new Error(`smoke ${summary.permalink} -> ${permRes.status}`);
smoke(permBody.includes(`<link rel="canonical" href="${summary.permalink}">`), "permalink canonical tag");
smoke(permBody.includes(`<option value="${permalinkPath}">`), "permalink archive option");
const permLines = permBody.match(/This is the permanent edition/g) || [];
smoke(permLines.length === 1, `exactly one permanent-edition line (got ${permLines.length})`);
smoke(permBody.includes(`<a href="${permalinkPath}">`), "permanent-edition line points at this issue");

const homeUrl = summary.permalink.replace(/[^/]+\/$/, "");
const homeRes = await fetch(homeUrl);
const homeBody = await homeRes.text();
if (!homeRes.ok) throw new Error(`smoke ${homeUrl} -> ${homeRes.status}`);
smoke(homeBody.includes(`<link rel="canonical" href="${summary.permalink}">`), "genre home canonical points at the new permalink");
smoke(!homeBody.includes("This is the permanent edition"), "genre home carries no permanent-edition line");
smoke(homeBody.includes(`<option value="${permalinkPath}">`), "genre home archive option");
log("smoke tests passed on permalink + genre home");

// ---- 1b. Create (or confirm) the draft issues row — AFTER the deploy is
// proven live, so a broken deploy never leaves a row claiming a dead
// permalink. This job holds the runner DB token; the produce job never does
// after its pre-seat prepare step. ----
const row = await upsertDraftIssue(summary.genre, summary.month, summary.permalink);
if (row.status !== "draft") {
  throw new Error(`issues row ${row.id} is '${row.status}', not draft — the world changed since prepare; refusing`);
}
summary.issue_id = row.id;
log(`issues row ${row.id} (draft)`);

function smoke(ok, name) {
  if (!ok) throw new Error(`smoke assertion failed: ${name}`);
  log(`smoke ok: ${name}`);
}

// ---- 2. Record publication through the write lane (MCP over HTTP) ----
const laneUrl = requireEnv("WRITE_LANE_URL"); // full connector URL incl. token — a GitHub secret Steve sets
async function laneCall(name, args) {
  const res = await fetch(laneUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`lane ${name} -> ${res.status}: ${text.slice(0, 300)}`);
  const jsonText = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  const rpc = JSON.parse(jsonText);
  if (rpc.error) throw new Error(`lane ${name} rpc error: ${JSON.stringify(rpc.error).slice(0, 300)}`);
  const content = rpc.result?.content?.[0]?.text;
  const out = content ? JSON.parse(content) : rpc.result;
  if (out && out.ok === false) throw new Error(`lane ${name} refused: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

const probe = await laneCall("genre_write_probe", {});
log(`lane probe ok (probe_id ${probe.probe_id ?? "?"})`);

const recorded = await laneCall("genre_record_issue_published", {
  issue_id: summary.issue_id,
  send_payload: summary.send_payload,
  adversary_rounds: summary.adversary_rounds,
  adversary_verdict: summary.adversary_verdict,
  story_count: summary.story_count ?? undefined,
  production_notes:
    `Produced by the API runner (DR-0168), workflow run ${process.env.GITHUB_RUN_ID || "local"}; ` +
    `pack ${summary.pack_month} v${summary.pack_version}. ` +
    (summary.klytics_used ? "K-lytics extract fresh this cycle." : "No fresh K-lytics extract; issue ran without it."),
});
log(`recorded published: ${JSON.stringify(recorded)}`);

// ---- 3. Notify Steve (credential-free by design; his click is the send gate) ----
const notifyRes = await fetch("https://reports.stevepieper.com/api/notify-draft", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ issue_id: summary.issue_id }),
});
const notify = await notifyRes.json().catch(() => ({}));
if (!notifyRes.ok || notify.ok === false) {
  // A "recently notified" cooldown skip is success, not failure.
  if (!/recent/i.test(JSON.stringify(notify))) throw new Error(`notify-draft -> ${notifyRes.status}: ${JSON.stringify(notify).slice(0, 300)}`);
}
log(`notify: ${JSON.stringify(notify)}`);
log("publish step complete — the send now waits on Steve's one-click approval, as ruled.");
