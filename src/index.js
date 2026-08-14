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
 * API (double opt-in, design doc §2.13 / Worker+Supabase):
 *   POST /api/subscribe   {genre, email, first_name}  → pending row + confirmation email
 *   GET  /api/confirm?token=...                       → flips subscriber to confirmed
 *   GET  /api/unsubscribe?token=...                   → flips subscriber to unsubscribed
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
    if (url.pathname === "/api/confirm" && request.method === "GET") {
      return await confirm(url, request, env, ctx);
    }
    if (url.pathname === "/api/unsubscribe" && request.method === "GET") {
      return await unsubscribe(url, env);
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
      customData: { genre: (row.genres || {}).slug, consent_source: row.consent_source },
    }));
  }
  const g = row.genres || {};
  return Response.redirect(
    `https://${CANONICAL_HOST}/${g.slug || ""}/?subscribed=1`,
    302
  );
}

async function unsubscribe(url, env) {
  const token = url.searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/.test(token)) return htmlPage("That link doesn't look right.", 400);

  const rows = await sb(env, `subscribers?doi_token=eq.${token}&select=id,status`, "GET");
  if (!rows.length) return htmlPage("This link is invalid.", 404);

  if (rows[0].status !== "unsubscribed") {
    await sb(env, `subscribers?id=eq.${rows[0].id}`, "PATCH", {
      status: "unsubscribed",
      unsubscribed_at: new Date().toISOString(),
    });
  }
  return htmlPage("You're unsubscribed. No hard feelings — the archive stays open to you.", 200);
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
  const pub = `${genre.display_name} Monthly`;
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
          <p style="margin:0 0 4px;font-size:14px;color:#444444;">Every claim cited, every figure sourced. New issue on the 1st.</p>
          <hr style="border:none;border-top:1px solid #e5e1d8;margin:20px 0;">
          <p style="margin:0;font-size:13px;color:#8a8578;">If you didn't request this, ignore this email and nothing happens.<br>
            — Steve Pieper, Polymath Consulting &amp; Publishing</p>
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
        `— Steve Pieper\nPolymath Consulting & Publishing`,
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
