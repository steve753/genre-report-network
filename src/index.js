/**
 * Genre Report Network — single Worker serving the whole publication network.
 *
 * Routing model (design doc §2.6–2.7, §4):
 *   reports.stevepieper.com/{genre}/            → genre home: latest issue content,
 *                                                 rel=canonical → dated permalink
 *   reports.stevepieper.com/{genre}/{mmm}-{yyyy} → immutable permalink (static asset)
 *   {genre}.stevepieper.com/*                   → vanity hostname, 301 → canonical genre home
 *   any other proxied hostname                  → pass through to origin untouched
 *
 * API (double opt-in, design doc §2.13 / Worker+Supabase).
 * State changes require a click (registry: genre_reports.network.doi_token_behavior):
 * a bare GET never mutates subscriber state — corporate link-scanners fetch every
 * link in an email and must not be able to confirm or unsubscribe anyone.
 *   POST /api/subscribe   {genre, email, first_name}  → pending row + confirmation email
 *   GET  /api/confirm?token=...                       → renders a page whose button POSTs
 *   POST /api/confirm?token=...                       → flips subscriber to confirmed
 *   GET  /api/unsubscribe?token=...                   → renders a page whose button POSTs
 *   POST /api/unsubscribe?token=...                   → flips to unsubscribed; RFC 8058
 *                                                       one-click posts always answer 200
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY, POSTMARK_TOKEN, DOI_SIGNING_SECRET.
 * The Supabase REST calls target the genre_reports schema via PostgREST profile
 * headers — the schema must be listed under "Exposed schemas" in the Supabase
 * dashboard (Settings → API) for these calls to work.
 */

import genresConfig from "../config/genres.json";

const CANONICAL_HOST = "reports.stevepieper.com";
const APEX = "stevepieper.com";

// ---------------------------------------------------------------------------
// Genre lookup (slug + aliases), mirroring genre_reports.slugify / find_genre
// ---------------------------------------------------------------------------
function slugify(input) {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

const GENRES = new Map();
for (const g of genresConfig.genres) {
  GENRES.set(g.slug, g);
  for (const a of g.aliases || []) GENRES.set(slugify(a), g);
}

// Publication naming follows the genre's launch tier (registry:
// genre_reports.network.cadence) — the masthead and every email promise
// only the cadence the pipeline actually delivers.
function pubName(genre) {
  return `${genre.display_name} ${genre.tier === "monthly" ? "Monthly" : "Quarterly"}`;
}
function cadenceLine(genre) {
  return genre.tier === "monthly"
    // Truthful cadence (genre_reports.network.cadence): "on the 1st" returns
    // only when scheduled production actually delivers on the 1st. The live
    // pages made this change 2026-09-03; the DOI email follows suit here.
    ? "Every claim cited, every figure sourced. Published monthly."
    : "Every claim cited, every figure sourced. Published quarterly.";
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // 1) Canonical site
    if (host === CANONICAL_HOST) {
      if (url.pathname.startsWith("/api/")) return handleApi(request, url, env, ctx);
      // One-click approval console: GET renders the review page (never
      // mutates), POST re-checks every gate and dispatches. Same
      // GET-renders/POST-acts doctrine as /api/confirm and /api/unsubscribe
      // (genre_reports.network.doi_token_behavior).
      if (url.pathname === "/approve") {
        try {
          if (request.method === "GET") return await approvePage(url, env);
          if (request.method === "POST") return await approveSubmit(request, env);
          return new Response("method not allowed", { status: 405 });
        } catch (err) {
          console.error("approve error", err.stack || String(err));
          return consolePage("Temporary error", "<p>Something went wrong on our side. If you had just clicked Approve, <strong>do not assume nothing was sent</strong> — check <code>genre_reports.email_log</code> for this issue before retrying (the dedup log skips anyone already sent). Otherwise, reload the review link.</p>", 500);
        }
      }
      return env.ASSETS.fetch(request);
    }

    // 2) Vanity genre hostnames: {genre}.stevepieper.com → canonical genre home.
    //    Anything that isn't a known genre slug/alias passes through to origin,
    //    so existing proxied subdomains (e.g. direct.stevepieper.com) are unaffected.
    if (host !== APEX && host.endsWith("." + APEX)) {
      const label = host.slice(0, -("." + APEX).length);
      const genre = GENRES.get(label);
      if (genre) {
        return Response.redirect(
          `https://${CANONICAL_HOST}/${genre.slug}/`,
          301
        );
      }
    }

    // 3) Everything else: not ours — pass through untouched.
    return fetch(request);
  },
};

// ---------------------------------------------------------------------------
// API — double opt-in against Supabase (genre_reports schema)
// ---------------------------------------------------------------------------
async function handleApi(request, url, env, ctx) {
  try {
    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      return await subscribe(request, env, ctx);
    }
    if (
      url.pathname === "/api/confirm" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return await confirm(url, request, env, ctx);
    }
    // GET = a human clicking the link in an email body → click-through page.
    // POST = the page's button, or RFC 8058 one-click from the mailbox provider.
    // The one-click path must always answer 200: a provider that POSTs and
    // receives non-2xx records the unsubscribe as failed while
    // List-Unsubscribe-Post promises it worked.
    if (
      url.pathname === "/api/unsubscribe" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return await unsubscribe(url, request, env);
    }
    if (url.pathname === "/api/send-issue" && request.method === "POST") {
      return await sendIssue(request, env);
    }
    // Credential-free by design: its only power is emailing the review link
    // to the FIXED approver address. It cannot approve, send, or read
    // anything back to the caller beyond ok/skipped.
    if (url.pathname === "/api/notify-draft" && request.method === "POST") {
      return await notifyDraft(request, env);
    }
    return json({ error: "not found" }, 404);
  } catch (err) {
    // Never leak internals; log for observability.
    console.error("api error", url.pathname, err.stack || String(err));
    return json({ error: "temporary error, please try again" }, 500);
  }
}

async function subscribe(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const firstName = String(body.first_name || "").trim().slice(0, 100);
  const genreSlug = slugify(String(body.genre || ""));
  const consentSource = String(body.consent_source || "web-form").slice(0, 500);

  const genre = GENRES.get(genreSlug);
  if (!genre) return json({ error: "unknown genre" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return json({ error: "invalid email" }, 400);
  }

  // Resolve genre UUID, then upsert the pending subscriber.
  const g = await sb(env, `genres?slug=eq.${genre.slug}&select=id`, "GET");
  if (!g.length) return json({ error: "unknown genre" }, 400);
  const genreId = g[0].id;

  const rows = await sb(
    env,
    "subscribers?on_conflict=email,genre_id",
    "POST",
    [{ email, first_name: firstName, genre_id: genreId, consent_source: consentSource }],
    { Prefer: "resolution=ignore-duplicates,return=representation" }
  );

  // Existing row (duplicate): re-fetch to get its doi_token/status.
  const row =
    rows[0] ||
    (await sb(env, `subscribers?email=eq.${encodeURIComponent(email)}&genre_id=eq.${genreId}&select=*`, "GET"))[0];

  if (row.status === "confirmed") {
    return json({ ok: true, state: "already-subscribed" });
  }

  await sendConfirmationEmail(env, { email, firstName, genre, token: row.doi_token });
  await sb(env, `subscribers?id=eq.${row.id}`, "PATCH", { doi_sent_at: new Date().toISOString() });

  // Meta CAPI: subscribe-start (Lead). Fire-and-forget; never blocks the response.
  if (ctx) ctx.waitUntil(sendMetaEvent(env, request, {
    eventName: "Lead",
    eventId: `${row.doi_token}-lead`,
    email,
    customData: { genre: genre.slug, consent_source: consentSource },
  }));

  return json({ ok: true, state: "confirmation-sent" });
}

async function confirm(url, request, env, ctx) {
  const token = url.searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/.test(token)) return htmlPage("That link doesn't look right.", 400);

  const rows = await sb(
    env,
    `subscribers?doi_token=eq.${token}&select=id,status,email,consent_source,genre_id,genres:genre_id(slug,display_name)`,
    "GET"
  );
  if (!rows.length) return htmlPage("This confirmation link is invalid or was already used.", 404);

  const row = rows[0];
  const g = row.genres || {};
  const cfg = GENRES.get(g.slug || "");
  const pub = cfg ? pubName(cfg) : "our report";

  // GET renders; only the button's POST mutates
  // (registry: genre_reports.network.doi_token_behavior).
  if (request.method === "GET") {
    if (row.status !== "pending") {
      return Response.redirect(`https://${CANONICAL_HOST}/${g.slug || ""}/?subscribed=1`, 302);
    }
    return htmlPage(
      `One click to go — confirm your free subscription to <strong>${pub}</strong>.` +
        `<form method="post" action="/api/confirm?token=${token}" style="margin:1.2rem 0">` +
        `<button type="submit" style="background:#a31621;color:#fff;border:none;border-radius:4px;` +
        `padding:.7rem 1.4rem;font-weight:700;font-size:1rem;cursor:pointer">Confirm my subscription</button></form>`,
      200
    );
  }

  if (row.status === "pending") {
    await sb(env, `subscribers?id=eq.${row.id}`, "PATCH", {
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
    });
    // Meta CAPI: confirmed double opt-in (CompleteRegistration).
    if (ctx) ctx.waitUntil(sendMetaEvent(env, request, {
      eventName: "CompleteRegistration",
      eventId: `${token}-confirm`,
      email: row.email,
      customData: { genre: g.slug, consent_source: row.consent_source },
    }));
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `https://${CANONICAL_HOST}/${g.slug || ""}/?subscribed=1` },
  });
}

async function unsubscribe(url, request, env) {
  // GET renders a click-through page; only a POST mutates
  // (registry: genre_reports.network.doi_token_behavior).
  // POST callers are two species: the click-through page's button (a human),
  // and RFC 8058 one-click from a mailbox provider (a machine, whose body is
  // "List-Unsubscribe=One-Click"). Machines want a 2xx and nothing else — any
  // non-2xx, including for a token we don't recognise, is recorded by the
  // provider as a failed unsubscribe while List-Unsubscribe-Post promised it
  // worked. So the machine path always answers 200.
  const isPost = request.method === "POST";
  const isOneClick =
    isPost && (await request.text().catch(() => "")).includes("List-Unsubscribe=One-Click");
  const ok = () => new Response("OK", { status: 200 });

  const token = url.searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/.test(token)) {
    return isOneClick ? ok() : htmlPage("That link doesn't look right.", 400);
  }

  const rows = await sb(env, `subscribers?doi_token=eq.${token}&select=id,status`, "GET");
  if (!rows.length) {
    return isOneClick ? ok() : htmlPage("This link is invalid.", 404);
  }

  if (!isPost) {
    if (rows[0].status === "unsubscribed") {
      return htmlPage("You're already unsubscribed — nothing more is coming.", 200);
    }
    return htmlPage(
      `Sorry to see you go. One click and you're out — immediately, no questions.` +
        `<form method="post" action="/api/unsubscribe?token=${token}" style="margin:1.2rem 0">` +
        `<button type="submit" style="background:#1c1c1c;color:#fff;border:none;border-radius:4px;` +
        `padding:.7rem 1.4rem;font-weight:700;font-size:1rem;cursor:pointer">Unsubscribe me</button></form>`,
      200
    );
  }

  if (rows[0].status !== "unsubscribed") {
    await sb(env, `subscribers?id=eq.${rows[0].id}`, "PATCH", {
      status: "unsubscribed",
      unsubscribed_at: new Date().toISOString(),
    });
  }
  return isOneClick
    ? ok()
    : htmlPage("You're unsubscribed. No hard feelings — the archive stays open to you.", 200);
}

// ---------------------------------------------------------------------------
// Broadcast sender — POST /api/send-issue
//
// Ruled gates it implements:
//   - UNARMED BY DEFAULT (genre_reports.network.dormancy): without the
//     SEND_AUTH_TOKEN secret the endpoint answers 503 and nothing can send.
//     Arming (setting the secret) and per-send copy approval remain Steve's.
//   - Audience is the sendable view only — confirmed subscribers
//     (genre_reports.network.dormancy: "confirmed subscribers means
//     status='confirmed'").
//   - CAN-SPAM address block COUNTED, exactly once, in BOTH HtmlBody and
//     TextBody of every message (genre_reports.network.canspam_address);
//     any other count refuses the whole send.
//   - List-Unsubscribe + List-Unsubscribe-Post headers point at the deployed
//     one-click endpoint (genre_reports.network.canspam_address).
//   - email_log dedup: a subscriber with a 'sent' row for this issue is
//     skipped, so a repeated invocation is safe.
//   - All links built from config, never from the request URL.
//
// Body: { issue_id, genre, subject, teaser_bullets: [..], permalink_url,
//         dry_run?: true }
// dry_run renders and counts everything, writes nothing, sends nothing,
// and returns the audience size plus one rendered sample.
// ---------------------------------------------------------------------------
const CANSPAM_ADDRESS_LINE = "8215 Blossom Hill Lane, Suite 302";

async function sendIssue(request, env) {
  if (!env.SEND_AUTH_TOKEN) {
    console.log("broadcast_refused_not_armed");
    return json({ error: "sender not armed" }, 503);
  }
  const auth = request.headers.get("Authorization") || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(presented, env.SEND_AUTH_TOKEN)) {
    console.log("broadcast_refused_bad_token");
    return json({ error: "unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const result = await executeSend(env, {
    issueId: String(body.issue_id || ""),
    genreSlug: slugify(String(body.genre || "")),
    subject: String(body.subject || "").trim(),
    bullets: Array.isArray(body.teaser_bullets)
      ? body.teaser_bullets.map((b) => String(b)).filter(Boolean).slice(0, 6)
      : [],
    permalink: String(body.permalink_url || ""),
    dryRun: body.dry_run === true,
  });
  return json(result.payload, result.httpStatus);
}

// The single send path. Both callers go through here so the gates cannot
// diverge: /api/send-issue (bearer-token, terminal script) and the one-click
// approval console. ARMING IS CHECKED BY THE CALLERS (SEND_AUTH_TOKEN present
// + their own authentication) before this runs with dryRun=false.
async function executeSend(env, { issueId, genreSlug, subject, bullets, permalink, dryRun }) {
  const genre = GENRES.get(genreSlug);
  if (!genre) return { httpStatus: 400, payload: { error: "unknown genre" } };
  if (!/^[0-9a-f-]{36}$/.test(issueId)) return { httpStatus: 400, payload: { error: "invalid issue_id" } };
  if (!subject || bullets.length === 0) {
    return { httpStatus: 400, payload: { error: "subject and teaser_bullets are required" } };
  }
  if (!permalink.startsWith(`https://${CANONICAL_HOST}/${genre.slug}/`)) {
    return { httpStatus: 400, payload: { error: "permalink_url must live under the genre's canonical path" } };
  }

  // Issue must exist and belong to this genre.
  const issues = await sb(
    env,
    `issues?id=eq.${issueId}&select=id,status,genre_id,genres_all:genre_id(slug)`,
    "GET"
  );
  if (!issues.length) return { httpStatus: 404, payload: { error: "unknown issue" } };
  if ((issues[0].genres_all || {}).slug !== genre.slug) {
    return { httpStatus: 400, payload: { error: "issue does not belong to this genre" } };
  }
  // Status gate lives in the choke point so no caller can diverge (adversary
  // round 2026-09-03, finding 1: a retracted issue must refuse on EVERY send
  // path, not only on the review page's rendering). Operational consequence:
  // the telemetry SQL that marks the issue published now runs BEFORE the
  // send, not after — dry runs included.
  if (issues[0].status !== "published") {
    console.log("broadcast_refused_not_published", issueId, issues[0].status);
    return { httpStatus: 409, payload: {
      error: `issue status is '${issues[0].status}', not 'published' — record publication first; send refused`,
    } };
  }

  // Audience: confirmed subscribers for the genre, minus already-sent.
  const audience = await sb(
    env,
    `sendable?genre_slug=eq.${genre.slug}&select=subscriber_id,email,first_name,doi_token`,
    "GET"
  );
  const sentRows = await sb(
    env,
    `email_log?issue_id=eq.${issueId}&status=eq.sent&select=subscriber_id`,
    "GET"
  );
  const alreadySent = new Set(sentRows.map((r) => r.subscriber_id));
  const recipients = audience.filter((s) => !alreadySent.has(s.subscriber_id));

  const pub = pubName(genre);
  const messages = recipients.map((s) => renderIssueEmail(env, {
    subscriber: s, genre, pub, subject, bullets, permalink,
  }));

  // DR-0163: COUNT the address block — exactly one in each body of every
  // message, or the whole send refuses. A presence check passes happily with
  // duplicates; a count does not.
  for (const m of messages) {
    const htmlCount = countOccurrences(m.HtmlBody, CANSPAM_ADDRESS_LINE);
    const textCount = countOccurrences(m.TextBody, CANSPAM_ADDRESS_LINE);
    if (htmlCount !== 1 || textCount !== 1) {
      console.error("broadcast_refused_canspam_count", "html", htmlCount, "text", textCount);
      return { httpStatus: 500, payload: {
        error: `CAN-SPAM address block count wrong (html=${htmlCount}, text=${textCount}); send refused`,
      } };
    }
  }

  if (dryRun) {
    console.log("broadcast_dry_run", "issue", issueId, "genre", genre.slug,
      "audience", recipients.length, "skipped_already_sent", alreadySent.size);
    return { httpStatus: 200, payload: {
      ok: true, dry_run: true, audience: recipients.length,
      skipped_already_sent: alreadySent.size,
      sample: messages[0] ? {
        To: messages[0].To, Subject: messages[0].Subject,
        HtmlBody: messages[0].HtmlBody, TextBody: messages[0].TextBody,
        Headers: messages[0].Headers,
      } : null,
    } };
  }

  if (recipients.length === 0) {
    return { httpStatus: 200, payload: { ok: true, sent: 0, failed: 0, skipped_already_sent: alreadySent.size } };
  }

  // Postmark batch endpoint: 500 messages per call.
  let sent = 0, failed = 0;
  for (let i = 0; i < messages.length; i += 500) {
    const chunk = messages.slice(i, i + 500);
    const res = await fetch("https://api.postmarkapp.com/email/batch", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`postmark batch ${res.status}: ${await res.text()}`);
    const results = await res.json();
    const logRows = [];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const rec = recipients[i + j];
      const ok = r.ErrorCode === 0;
      if (ok) sent++; else failed++;
      logRows.push({
        issue_id: issueId,
        subscriber_id: rec.subscriber_id,
        message_stream: "genre-reports",
        postmark_message_id: r.MessageID || null,
        status: ok ? "sent" : "failed",
        error: ok ? null : `${r.ErrorCode}: ${r.Message}`,
      });
    }
    await sb(env, "email_log", "POST", logRows, { Prefer: "return=minimal" });
  }

  console.log("broadcast_sent", "issue", issueId, "genre", genre.slug,
    "sent", sent, "failed", failed, "skipped_already_sent", alreadySent.size);
  return { httpStatus: 200, payload: { ok: true, sent, failed, skipped_already_sent: alreadySent.size } };
}

function countOccurrences(haystack, needle) {
  return String(haystack).split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// One-click approval (registry: genre_reports.network.send_approval_mechanism)
//
// Threat model, stated so nobody "simplifies" it away:
//  - The DB stores only sha256(token). Sessions hold read-only SQL access, so
//    a raw token in the DB would let a session construct the approve URL and
//    send. The raw token exists ONLY in the email to the approver.
//  - /api/notify-draft is deliberately credential-free: its whole capability
//    is "email the fixed approver a fresh link". Rate-limited per issue.
//  - GET /approve renders and never mutates. POST re-checks every gate AND
//    requires the reviewed-content hash, so a payload changed after review
//    refuses. The form posts to an ABSOLUTE URL (the Dangle v2 bug was a
//    relative post that 404'd).
//  - Arming is unchanged: without SEND_AUTH_TOKEN set, approve refuses too.
// ---------------------------------------------------------------------------
const APPROVER_EMAIL = "steve@stevepieper.com";
const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

function payloadHash(sendPayload) {
  // jsonb from PostgREST round-trips with deterministic key order.
  return sha256Hex(JSON.stringify(sendPayload));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchIssueForApproval(env, filter) {
  const rows = await sb(
    env,
    `issues?${filter}&select=id,month,status,approved_at,notified_at,send_payload,genre_id,genres_all:genre_id(slug)`,
    "GET"
  );
  return rows.length ? rows[0] : null;
}

function parsePayload(issue) {
  const p = issue.send_payload || {};
  return {
    issueId: issue.id,
    genreSlug: slugify(String(p.genre || "")),
    subject: String(p.subject || "").trim(),
    bullets: Array.isArray(p.teaser_bullets)
      ? p.teaser_bullets.map((b) => String(b)).filter(Boolean).slice(0, 6)
      : [],
    permalink: String(p.permalink_url || ""),
  };
}

async function notifyDraft(request, env) {
  const body = await request.json().catch(() => ({}));
  const issueId = String(body.issue_id || "");
  if (!/^[0-9a-f-]{36}$/.test(issueId)) return json({ error: "invalid issue_id" }, 400);

  const issue = await fetchIssueForApproval(env, `id=eq.${issueId}`);
  if (!issue) return json({ error: "unknown issue" }, 404);
  if (issue.status !== "published") {
    return json({ error: "issue is not published; nothing to approve yet" }, 409);
  }
  if (!issue.send_payload) {
    return json({ error: "issue has no send_payload; add it via the telemetry SQL first" }, 409);
  }
  const p = parsePayload(issue);
  const genre = GENRES.get(p.genreSlug);
  if (!genre || !p.subject || p.bullets.length === 0 ||
      !p.permalink.startsWith(`https://${CANONICAL_HOST}/${genre.slug}/`)) {
    return json({ error: "send_payload is malformed; fix it before notifying" }, 409);
  }
  // Cooldown FAILS CLOSED (adversary finding 8): an unparseable or future
  // notified_at skips rather than notifying — the endpoint is unauthenticated,
  // so any ambiguity resolves toward not sending mail.
  if (issue.notified_at) {
    const t = Date.parse(issue.notified_at);
    if (!Number.isFinite(t) || Date.now() - t < NOTIFY_COOLDOWN_MS) {
      console.log("notify_skipped_cooldown", issueId);
      return json({ ok: true, skipped: "recently notified" });
    }
  }

  // Fresh token per notification; the newest email supersedes older links.
  // The PATCH is a compare-and-swap on notified_at (finding 9): two racing
  // notifies produce one email, not two emails with one dead link.
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const notifyFilter = issue.notified_at
    ? `notified_at=eq.${encodeURIComponent(issue.notified_at)}`
    : "notified_at=is.null";
  const claimedRows = await sb(env, `issues?id=eq.${issueId}&${notifyFilter}`, "PATCH", {
    approval_token_hash: tokenHash,
    notified_at: new Date().toISOString(),
  }, { Prefer: "return=representation" });
  if (!claimedRows.length) {
    console.log("notify_lost_race", issueId);
    return json({ ok: true, skipped: "concurrent notification in flight" });
  }

  const pub = pubName(genre);
  const approveUrl = `https://${CANONICAL_HOST}/approve?token=${token}`;
  const bulletsText = p.bullets.map((b) => `  - ${b}`).join("\n");
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      From: "Steve Pieper <reports@stevepieper.com>",
      To: APPROVER_EMAIL,
      MessageStream: "outbound",
      Subject: `Review & approve: ${pub} — ${p.subject}`,
      TextBody:
`A new issue is ready for your review and send approval.

Publication: ${pub}
Subject line: ${p.subject}

Teasers:
${bulletsText}

Issue page: ${p.permalink}

Review the rendered email, the audience count, and every gate, then approve
the send with one click:

${approveUrl}

Opening the link changes nothing; only the Approve button on that page
sends. This link supersedes any earlier approval link for this issue.

— the Genre Report Network pipeline`,
      HtmlBody:
`<!doctype html><html><body style="font-family:'Avenir Next','Segoe UI',Arial,sans-serif;color:#1c1c1c;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
<p><strong>A new issue is ready for your review and send approval.</strong></p>
<p><strong>${escapeHtml(pub)}</strong><br>${escapeHtml(p.subject)}</p>
<ul>${p.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
<p><a href="${escapeHtml(p.permalink)}">Read the published issue page</a></p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="background-color:#a31621;border-radius:4px;">
<a href="${approveUrl}" style="display:inline-block;padding:13px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Review &amp; approve the send</a>
</td></tr></table>
<p style="font-size:13px;color:#666;">Opening the link changes nothing; only the Approve button on the review page sends. This link supersedes any earlier approval link for this issue.</p>
</body></html>`,
    }),
  });
  if (!res.ok) throw new Error(`postmark notify ${res.status}: ${await res.text()}`);
  console.log("notify_sent", "issue", issueId, "genre", genre.slug);
  return json({ ok: true, notified: true });
}

async function approveIssueFromToken(env, rawToken) {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;
  const tokenHash = await sha256Hex(rawToken);
  return fetchIssueForApproval(env, `approval_token_hash=eq.${tokenHash}`);
}

async function approvePage(url, env) {
  const rawToken = String(url.searchParams.get("token") || "");
  const issue = await approveIssueFromToken(env, rawToken);
  if (!issue) {
    return consolePage("Link not valid", "<p>This approval link is not valid — it may have been superseded by a newer notification email for the same issue. Use the most recent email, or trigger a fresh one.</p>", 404);
  }
  const p = parsePayload(issue);
  const genre = GENRES.get(p.genreSlug);

  // Gate report — every row rendered, computed now, server-side.
  const gates = [];
  const gate = (name, ok, detail) => gates.push({ name, ok, detail });

  gate("Sender armed (SEND_AUTH_TOKEN set)", Boolean(env.SEND_AUTH_TOKEN),
    env.SEND_AUTH_TOKEN ? "armed" : "NOT ARMED — approve will refuse");
  gate("Issue status", issue.status === "published", issue.status);
  gate("Payload well-formed", Boolean(genre && p.subject && p.bullets.length &&
    p.permalink.startsWith(`https://${CANONICAL_HOST}/${genre ? genre.slug : ""}/`)),
    genre ? `${genre.slug} · ${p.bullets.length} teasers` : "unknown genre");

  let audienceCount = 0, alreadySentCount = 0, sample = null;
  if (genre) {
    const audience = await sb(env,
      `sendable?genre_slug=eq.${genre.slug}&select=subscriber_id,email,first_name,doi_token`, "GET");
    const sentRows = await sb(env,
      `email_log?issue_id=eq.${issue.id}&status=eq.sent&select=subscriber_id`, "GET");
    const alreadySent = new Set(sentRows.map((r) => r.subscriber_id));
    alreadySentCount = alreadySent.size;
    const recipients = audience.filter((s) => !alreadySent.has(s.subscriber_id));
    audienceCount = recipients.length;
    const previewSub = recipients[0] ||
      { email: "preview@example.invalid", first_name: "", doi_token: "preview-token" };
    sample = renderIssueEmail(env, {
      subscriber: previewSub, genre, pub: pubName(genre),
      subject: p.subject, bullets: p.bullets, permalink: p.permalink,
    });
    const htmlCount = countOccurrences(sample.HtmlBody, CANSPAM_ADDRESS_LINE);
    const textCount = countOccurrences(sample.TextBody, CANSPAM_ADDRESS_LINE);
    gate("CAN-SPAM address counted once in each body", htmlCount === 1 && textCount === 1,
      `html=${htmlCount}, text=${textCount}`);
    gate("Recipients remaining", audienceCount > 0,
      `${audienceCount} to send · ${alreadySentCount} already sent (dedup)`);
  }
  const alreadyApproved = Boolean(issue.approved_at);
  const fullySent = audienceCount === 0 && alreadySentCount > 0;
  const reviewed = await payloadHash(issue.send_payload);
  const canApprove = gates.every((g) => g.ok) && !alreadyApproved;

  const gateRows = gates.map((g) =>
    `<tr><td style="padding:.35rem .6rem;">${g.ok ? "✅" : "❌"}</td><td style="padding:.35rem .6rem;font-weight:600;">${escapeHtml(g.name)}</td><td style="padding:.35rem .6rem;color:#555;">${escapeHtml(g.detail)}</td></tr>`
  ).join("\n");

  const statusBanner = alreadyApproved
    ? `<p style="background:#eef7ee;border:1px solid #9c9;padding:.8rem 1rem;border-radius:6px;"><strong>Already approved</strong> on ${escapeHtml(issue.approved_at)}. ${fullySent ? "The send completed; the dedup log holds the record." : ""}</p>`
    : fullySent
      ? `<p style="background:#eef7ee;border:1px solid #9c9;padding:.8rem 1rem;border-radius:6px;"><strong>Already sent.</strong> Every current subscriber has a sent row for this issue; approving again would send to nobody.</p>`
      : "";

  const approveBlock = canApprove
    ? `<form method="POST" action="https://${CANONICAL_HOST}/approve" style="margin:1.4rem 0;">
  <input type="hidden" name="token" value="${rawToken}">
  <input type="hidden" name="reviewed" value="${reviewed}">
  <button type="submit" style="background:#a31621;color:#fff;border:none;border-radius:4px;padding:.9rem 1.8rem;font-size:1.05rem;font-weight:700;cursor:pointer;">Approve — send to ${audienceCount} subscriber${audienceCount === 1 ? "" : "s"} now</button>
</form>
<p style="font-size:.85rem;color:#666;">The click re-checks every gate above and sends immediately. It is bound to exactly the content on this page; if anything changed since you loaded it, the send refuses and asks you to re-review.</p>`
    : `<p style="font-size:.95rem;color:#8a2020;font-weight:600;">Approve is disabled${alreadyApproved ? " — already approved" : " until every gate above passes"}.</p>`;

  const bulletItems = p.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n");
  const body = `
<p style="font-size:.8rem;letter-spacing:.14em;font-weight:800;color:#888;">GENRE REPORT NETWORK · SEND APPROVAL</p>
<h1 style="margin:.2rem 0 1rem;font-size:1.5rem;">${genre ? escapeHtml(pubName(genre)) : "Unknown publication"} — issue of ${escapeHtml(String(issue.month || ""))}</h1>
${statusBanner}
<h2 style="font-size:1.05rem;">What the email says</h2>
<p><strong>Subject:</strong> ${escapeHtml(p.subject)}</p>
<ul>${bulletItems}</ul>
<p><strong>Button links to:</strong> <a href="${escapeHtml(p.permalink)}">${escapeHtml(p.permalink)}</a></p>
<h2 style="font-size:1.05rem;">Gates (checked just now, server-side)</h2>
<table style="border-collapse:collapse;font-size:.92rem;">${gateRows}</table>
${approveBlock}
<h2 style="font-size:1.05rem;">Rendered email — exactly what subscribers receive</h2>
${sample ? `<iframe sandbox srcdoc="${escapeHtml(sample.HtmlBody)}" style="width:100%;height:640px;border:1px solid #ddd;border-radius:6px;background:#fff;"></iframe>
<details style="margin-top:.8rem;"><summary style="cursor:pointer;font-weight:600;">Plain-text version</summary><pre style="white-space:pre-wrap;background:#f6f4ef;padding:1rem;border-radius:6px;font-size:.85rem;">${escapeHtml(sample.TextBody)}</pre></details>` : "<p>No renderable sample (payload malformed).</p>"}
`;
  return consolePage("Send approval — " + (genre ? pubName(genre) : "Genre Report Network"), body, 200);
}

async function approveSubmit(request, env) {
  const form = await request.formData().catch(() => null);
  const rawToken = form ? String(form.get("token") || "") : "";
  const reviewed = form ? String(form.get("reviewed") || "") : "";

  const issue = await approveIssueFromToken(env, rawToken);
  if (!issue) {
    return consolePage("Link not valid", "<p>This approval link is not valid or has been superseded. Nothing was sent.</p>", 404);
  }
  if (issue.approved_at) {
    return consolePage("Already approved", `<p>This issue was already approved on ${escapeHtml(issue.approved_at)}. Nothing further was sent; the dedup log guards against duplicates in any case.</p>`, 200);
  }
  if (issue.status !== "published") {
    // Belt-and-braces with executeSend's own status gate: a retracted issue
    // refuses here with a message that names the state.
    console.log("approve_refused_not_published", issue.id, issue.status);
    return consolePage("Issue is not published", `<p>This issue's status is <code>${escapeHtml(String(issue.status))}</code>, not <code>published</code>. Nothing was sent.</p>`, 409);
  }
  if (!env.SEND_AUTH_TOKEN) {
    console.log("approve_refused_not_armed", issue.id);
    return consolePage("Sender not armed", "<p>The broadcast sender is not armed (SEND_AUTH_TOKEN is not set on the Worker). Nothing was sent.</p>", 503);
  }
  const currentHash = await payloadHash(issue.send_payload);
  if (!timingSafeEqual(reviewed, currentHash)) {
    console.log("approve_refused_stale_review", issue.id);
    return consolePage("Content changed since your review", `<p>The issue's send payload changed after the page you reviewed was rendered. Nothing was sent. <a href="https://${CANONICAL_HOST}/approve?token=${rawToken}">Re-open the review page</a> to see the current content, then approve that.</p>`, 409);
  }

  // CLAIM BEFORE SEND (adversary round 2026-09-03, finding 3): a conditional
  // PATCH on approved_at IS NULL is the compare-and-swap. Two racing POSTs:
  // exactly one gets a row back and dispatches; the loser sees the
  // already-approved page. Read-then-act would have dispatched twice —
  // email_log's unique index protects the table, not the mailbox.
  const claimed = await sb(env,
    `issues?id=eq.${issue.id}&approved_at=is.null`, "PATCH", {
      approved_at: new Date().toISOString(),
      approved_by: "one-click:" + APPROVER_EMAIL,
    }, { Prefer: "return=representation" });
  if (!claimed.length) {
    console.log("approve_lost_race", issue.id);
    return consolePage("Already approved", "<p>Another submission of this approval got there first. Nothing further was sent.</p>", 200);
  }

  const p = parsePayload(issue);
  let result;
  try {
    result = await executeSend(env, { ...p, dryRun: false });
  } catch (err) {
    // Release the claim so a retry is possible, then surface honestly: part
    // of a multi-chunk dispatch may have gone out before the failure.
    await sb(env, `issues?id=eq.${issue.id}`, "PATCH",
      { approved_at: null, approved_by: null }, { Prefer: "return=minimal" }).catch(() => {});
    console.error("approve_send_error", issue.id, err.stack || String(err));
    return consolePage("Send interrupted", `<p>The dispatch hit an error partway. <strong>Some messages may already have gone out</strong> — check <code>genre_reports.email_log</code> for issue <code>${escapeHtml(issue.id)}</code> before retrying; the dedup log will skip anyone already sent.</p>`, 500);
  }
  if (result.httpStatus !== 200 || !result.payload.ok) {
    await sb(env, `issues?id=eq.${issue.id}`, "PATCH",
      { approved_at: null, approved_by: null }, { Prefer: "return=minimal" }).catch(() => {});
    console.error("approve_send_refused", issue.id, JSON.stringify(result.payload));
    return consolePage("Send refused", `<p>The send gates refused: <code>${escapeHtml(String(result.payload.error || "unknown"))}</code>. Nothing was dispatched and nothing is recorded as approved — fix the cause and use the same link again.</p>`, 500);
  }

  const r = result.payload;
  console.log("approve_sent", "issue", issue.id, "sent", r.sent, "failed", r.failed);
  return consolePage("Sent", `
<p style="font-size:1.2rem;"><strong>✅ Approved and sent.</strong></p>
<p>Sent: <strong>${r.sent ?? 0}</strong> · Failed: <strong>${r.failed ?? 0}</strong> · Skipped (already had it): <strong>${r.skipped_already_sent ?? 0}</strong></p>
<p>The per-recipient record is in <code>genre_reports.email_log</code>.</p>`, 200);
}

function consolePage(title, bodyHtml, status) {
  return new Response(
`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;background:#f6f4ef;font-family:'Avenir Next','Segoe UI',system-ui,sans-serif;color:#1c1c1c;line-height:1.6;">
<div style="max-width:44rem;margin:0 auto;padding:2rem 1.2rem 4rem;">
${bodyHtml}
</div>
</body>
</html>`,
    { status, headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      // Defense in depth for the highest-privilege page in the system: no
      // scripts run on the console, period. Inline styles only; the preview
      // iframe is srcdoc (frame-src 'self' covers it) and sandboxed.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'",
    } }
  );
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function renderIssueEmail(env, { subscriber, genre, pub, subject, bullets, permalink }) {
  const name = subscriber.first_name || "there";
  const wordmark = pub.toUpperCase();
  const unsubUrl = `https://${CANONICAL_HOST}/api/unsubscribe?token=${subscriber.doi_token}`;
  const bulletsHtml = bullets
    .map((b) => `<li style="margin:0 0 8px;">${escapeHtml(b)}</li>`)
    .join("\n            ");
  const bulletsText = bullets.map((b) => `  - ${b}`).join("\n");

  const HtmlBody =
`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f2f0eb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f0eb;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td align="center" style="background-color:#12151a;border-radius:6px 6px 0 0;border-bottom:2px solid #c1932b;padding:28px 24px;">
          <div style="font-family:'Avenir Next','Segoe UI',Arial,sans-serif;font-weight:800;font-size:18px;letter-spacing:6px;color:#f5f2ea;">${wordmark}</div>
        </td></tr>
        <tr><td style="background-color:#ffffff;border-radius:0 0 6px 6px;padding:32px 32px 28px;font-family:'Avenir Next','Segoe UI',Arial,sans-serif;color:#1c1c1c;font-size:16px;line-height:1.6;">
          <p style="margin:0 0 14px;">Hi ${escapeHtml(name)},</p>
          <p style="margin:0 0 14px;">The new issue of <strong>${escapeHtml(pub)}</strong> is out. In this one:</p>
          <ul style="margin:0 0 22px;padding-left:20px;">
            ${bulletsHtml}
          </ul>
          <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 22px;">
            <tr><td align="center" style="background-color:#a31621;border-radius:4px;">
              <a href="${escapeHtml(permalink)}" style="display:inline-block;padding:13px 28px;font-family:'Avenir Next','Segoe UI',Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Read the issue</a>
            </td></tr>
          </table>
          <p style="margin:0 0 4px;font-size:14px;color:#444444;">Every claim cited, every figure sourced.</p>
          <hr style="border:none;border-top:1px solid #e5e1d8;margin:20px 0;">
          <p style="margin:0 0 12px;font-size:13px;color:#8a8578;">— Steve Pieper, Polymath Consulting &amp; Publishing</p>
          <p style="margin:0 0 12px;font-size:12px;line-height:1.5;color:#8a8578;">Polymath Consulting &amp; Publishing Inc<br>${CANSPAM_ADDRESS_LINE}<br>Parker, CO 80138</p>
          <p style="margin:0;font-size:12px;color:#8a8578;"><a href="${unsubUrl}" style="color:#8a8578;">Unsubscribe</a> — one click, honored immediately.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const TextBody =
`Hi ${name},

The new issue of ${pub} is out. In this one:

${bulletsText}

Read the issue:
${permalink}

Every claim cited, every figure sourced.

— Steve Pieper, Polymath Consulting & Publishing

—
Polymath Consulting & Publishing Inc
${CANSPAM_ADDRESS_LINE}
Parker, CO 80138

Unsubscribe (one click, honored immediately):
${unsubUrl}`;

  return {
    From: "Steve Pieper <reports@stevepieper.com>",
    To: subscriber.email,
    MessageStream: "genre-reports",
    Subject: subject,
    HtmlBody,
    TextBody,
    Headers: [
      { Name: "List-Unsubscribe", Value: `<${unsubUrl}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ],
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Supabase REST helper (PostgREST, genre_reports schema via profile headers)
// ---------------------------------------------------------------------------
async function sb(env, path, method, body, extraHeaders = {}) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...(method === "GET"
      ? { "Accept-Profile": "genre_reports" }
      : { "Content-Profile": "genre_reports" }),
    ...extraHeaders,
  };
  if (method !== "GET" && !("Prefer" in extraHeaders)) headers.Prefer = "return=representation";

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ---------------------------------------------------------------------------
// Meta Conversions API — server-side events from the Worker.
// No-ops silently until META_PIXEL_ID and META_CAPI_TOKEN secrets are set.
// event_id is derived from the DOI token so a future browser pixel firing the
// same events deduplicates cleanly. _fbp/_fbc are read from the request's own
// cookies (same-origin), so no client-side changes are needed.
// ---------------------------------------------------------------------------
async function sendMetaEvent(env, request, { eventName, eventId, email, customData }) {
  try {
    if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) {
      console.log("meta_capi_skipped_no_secrets", eventName);
      return;
    }

    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const userData = {
      em: [await sha256Hex(String(email || "").trim().toLowerCase())],
      client_ip_address: request.headers.get("CF-Connecting-IP") || undefined,
      client_user_agent: request.headers.get("User-Agent") || undefined,
      fbp: cookies._fbp || undefined,
      fbc: cookies._fbc || undefined,
    };

    const body = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: request.headers.get("Referer") || request.url,
        user_data: userData,
        custom_data: customData || {},
      }],
    };
    if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

    const res = await fetch(
      `https://graph.facebook.com/v23.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!res.ok) console.error("meta_capi_error", eventName, "pixel_id", env.META_PIXEL_ID, res.status, await res.text());
    else console.log("meta_capi_sent", eventName, "pixel_id", env.META_PIXEL_ID, "status", res.status);
  } catch (err) {
    console.error("meta_capi_exception", eventName, err.stack || String(err));
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Postmark — DOI confirmation (transactional stream)
// ---------------------------------------------------------------------------
async function sendConfirmationEmail(env, { email, firstName, genre, token }) {
  const confirmUrl = `https://${CANONICAL_HOST}/api/confirm?token=${token}`;
  const name = firstName || "there";
  const pub = pubName(genre);
  const cadence = cadenceLine(genre);
  const wordmark = pub.toUpperCase();
  const htmlBody =
`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f2f0eb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f0eb;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <!-- masthead -->
        <tr><td align="center" style="background-color:#12151a;border-radius:6px 6px 0 0;border-bottom:2px solid #c1932b;padding:28px 24px;">
          <div style="font-family:'Avenir Next','Segoe UI',Arial,sans-serif;font-weight:800;font-size:18px;letter-spacing:6px;color:#f5f2ea;">${wordmark}</div>
        </td></tr>
        <!-- card -->
        <tr><td style="background-color:#ffffff;border-radius:0 0 6px 6px;padding:32px 32px 28px;font-family:'Avenir Next','Segoe UI',Arial,sans-serif;color:#1c1c1c;font-size:16px;line-height:1.6;">
          <p style="margin:0 0 14px;">Hi ${name},</p>
          <p style="margin:0 0 22px;">One click and you're in — confirm your free subscription to <strong>${pub}</strong>:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 22px;">
            <tr><td align="center" style="background-color:#a31621;border-radius:4px;">
              <a href="${confirmUrl}" style="display:inline-block;padding:13px 28px;font-family:'Avenir Next','Segoe UI',Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Confirm my subscription</a>
            </td></tr>
          </table>
          <p style="margin:0 0 22px;font-size:13px;color:#6b6b6b;">Button not working? Paste this link into your browser:<br>
            <a href="${confirmUrl}" style="color:#a31621;word-break:break-all;">${confirmUrl}</a></p>
          <p style="margin:0 0 4px;font-size:14px;color:#444444;">${cadence}</p>
          <hr style="border:none;border-top:1px solid #e5e1d8;margin:20px 0;">
          <p style="margin:0 0 12px;font-size:13px;color:#8a8578;">If you didn't request this, ignore this email and nothing happens.<br>
            — Steve Pieper, Polymath Consulting &amp; Publishing</p>
          <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8578;">Polymath Consulting &amp; Publishing Inc<br>8215 Blossom Hill Lane, Suite 302<br>Parker, CO 80138</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      From: "Steve Pieper <reports@stevepieper.com>",
      To: email,
      MessageStream: "outbound", // transactional stream for DOI
      Subject: `Confirm your ${pub} subscription`,
      HtmlBody: htmlBody,
      TextBody:
        `Hi ${name},\n\n` +
        `One click and you're in: confirm your subscription to ${pub} here:\n\n` +
        `${confirmUrl}\n\n` +
        `If you didn't request this, ignore this email and nothing happens.\n\n` +
        `— Steve Pieper\nPolymath Consulting & Publishing\n\n` +
        `—\nPolymath Consulting & Publishing Inc\n` +
        `8215 Blossom Hill Lane, Suite 302\nParker, CO 80138`,
    }),
  });
  if (!res.ok) throw new Error(`postmark ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlPage(message, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Genre Reports</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.6">` +
      `<p>${message}</p><p><a href="https://${CANONICAL_HOST}/">Genre Reports home</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
