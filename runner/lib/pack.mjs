// Data-pack access. Reads go through genre_reports.runner_read_pack — a
// SECURITY DEFINER function limited to data packs and genre config
// (ruled 2026-09-04, runner decisions question 3). The licensed K-lytics
// extract is returned ONLY when the Vault-checked runner token validates —
// the anon key alone can never read it. Draft-row creation goes through
// genre_reports.runner_upsert_draft behind the same token.

import { requireEnv, log } from "./util.mjs";

async function rpc(fn, body) {
  const url = `${requireEnv("SUPABASE_URL")}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: requireEnv("SUPABASE_ANON_KEY"),
      Authorization: `Bearer ${requireEnv("SUPABASE_ANON_KEY")}`,
      "Content-Type": "application/json",
      "Accept-Profile": "genre_reports",
      "Content-Profile": "genre_reports",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${fn} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Returns { genre, pack, shared_pack, klytics, existing_issue }.
// - pack is the newest pack for the genre WHOSE pack_month EQUALS p_month;
//   a stale pack comes back as { stale: true, pack_month } with no payload,
//   and the caller refuses unless explicitly allowed (a silently failed pull
//   must never publish last month's data as this month's issue).
// - klytics is null when no K-lytics row is fresh OR the token is absent.
// - existing_issue is the issues row for genre+month if one exists, so the
//   runner can refuse to touch an already-published cycle before any spend.
export async function fetchPack(genreSlug, monthDate, { klyticsMaxAgeDays = 45, allowStalePack = false, deferFreshness = false } = {}) {
  const out = await rpc("runner_read_pack", {
    p_genre: genreSlug,
    p_month: monthDate,
    p_klytics_max_age_days: klyticsMaxAgeDays,
    p_token: process.env.RUNNER_DB_TOKEN || null,
  });
  if (!out || !out.genre) throw new Error(`runner_read_pack returned no genre row for ${genreSlug}`);
  if (!deferFreshness) {
    if (!out.pack) throw new Error(`no data pack exists at all for ${genreSlug} — did the pg_cron pull ever run?`);
    if (out.pack.stale) {
      const msg = `pack for ${genreSlug} is STALE (pack_month ${out.pack.pack_month}, issue month ${monthDate}) — the 05:30 pull likely failed`;
      if (!allowStalePack) throw new Error(msg + "; refusing (pass --allow-stale-pack only deliberately)");
      log("WARNING: " + msg + "; proceeding under --allow-stale-pack");
    }
  }
  log(
    `pack for ${genreSlug}: ${out.pack ? `month ${out.pack.pack_month} v${out.pack.version}${out.pack.stale ? " (STALE)" : ""}` : "MISSING"}; klytics ${
      out.klytics ? "fresh" : "ABSENT"
    }; existing issue: ${out.existing_issue ? `${out.existing_issue.id} (${out.existing_issue.status})` : "none"}`
  );
  return out;
}

// Creates (or returns the existing) draft issues row for genre+month.
// Postgres enforces: token check, draft-only creation, idempotent re-call,
// no approval fields. Returns { id, status, created }.
export async function upsertDraftIssue(genreSlug, monthDate, permalinkUrl) {
  return rpc("runner_upsert_draft", {
    p_token: requireEnv("RUNNER_DB_TOKEN"),
    p_genre: genreSlug,
    p_month: monthDate,
    p_permalink_url: permalinkUrl,
  });
}
