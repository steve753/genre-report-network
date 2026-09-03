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
    ? "Every claim cited, every figure sourced. New issue on the 1st."
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
  const issueId = String(body.issue_id || "");
  const genreSlug = slugify(String(body.genre || ""));
  const subject = String(body.subject || "").trim();
  const bullets = Array.isArray(body.teaser_bullets)
    ? body.teaser_bullets.map((b) => String(b)).filter(Boolean).slice(0, 6)
    : [];
  const permalink = String(body.permalink_url || "");
  const dryRun = body.dry_run === true;

  const genre = GENRES.get(genreSlug);
  if (!genre) return json({ error: "unknown genre" }, 400);
  if (!/^[0-9a-f-]{36}$/.test(issueId)) return json({ error: "invalid issue_id" }, 400);
  if (!subject || bullets.length === 0) {
    return json({ error: "subject and teaser_bullets are required" }, 400);
  }
  if (!permalink.startsWith(`https://${CANONICAL_HOST}/${genre.slug}/`)) {
    return json({ error: "permalink_url must live under the genre's canonical path" }, 400);
  }

  // Issue must exist and belong to this genre.
  const issues = await sb(
    env,
    `issues?id=eq.${issueId}&select=id,genre_id,genres_all:genre_id(slug)`,
    "GET"
  );
  if (!issues.length) return json({ error: "unknown issue" }, 404);
  if ((issues[0].genres_all || {}).slug !== genre.slug) {
    return json({ error: "issue does not belong to this genre" }, 400);
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
      return json({
        error: `CAN-SPAM address block count wrong (html=${htmlCount}, text=${textCount}); send refused`,
      }, 500);
    }
  }

  if (dryRun) {
    console.log("broadcast_dry_run", "issue", issueId, "genre", genre.slug,
      "audience", recipients.length, "skipped_already_sent", alreadySent.size);
    return json({
      ok: true, dry_run: true, audience: recipients.length,
      skipped_already_sent: alreadySent.size,
      sample: messages[0] ? {
        To: messages[0].To, Subject: messages[0].Subject,
        HtmlBody: messages[0].HtmlBody, TextBody: messages[0].TextBody,
        Headers: messages[0].Headers,
      } : null,
    });
  }

  if (recipients.length === 0) {
    return json({ ok: true, sent: 0, failed: 0, skipped_already_sent: alreadySent.size });
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
  return json({ ok: true, sent, failed, skipped_already_sent: alreadySent.size });
}

function countOccurrences(haystack, needle) {
  return String(haystack).split(needle).length - 1;
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
              <a href="${permalink}" style="display:inline-block;padding:13px 28px;font-family:'Avenir Next','Segoe UI',Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Read the issue</a>
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
