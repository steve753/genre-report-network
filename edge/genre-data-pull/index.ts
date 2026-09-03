// ============================================================================
// genre-data-pull — Stage 1 of the Genre Report Network pipeline.
// Registry: genre_reports.network.stage1_data_pull (DR-0159).
//
// NYT Books API + Rainforest pulls, keys read from Vault via the
// genre_reports.data_pull_keys() accessor (SECURITY DEFINER, service_role
// only). Writes one versioned data pack per invocation into
// genre_reports.data_packs. Sources without APIs go to human_fetch_queue —
// never scraped, never silently dropped.
//
// Invoke (Steve, or pg_cron later):
//   POST /functions/v1/genre-data-pull
//   Headers: Authorization: Bearer <anon or service key>,
//            x-pull-token: <DATA_PULL_TOKEN function secret>
//   Body: { "genre": "fantasy" }   or   { "genre": "shared" }
//   Optional: { "descriptions_top_n": 9 }  (product-description harvest depth)
//
// Deploy: Supabase dashboard → Edge Functions → New function
//   name: genre-data-pull · verify_jwt: ON (default) — callers pass the
//   project anon key as Bearer plus x-pull-token.
//   Secrets: DATA_PULL_TOKEN (dashboard → Edge Functions → genre-data-pull →
//   Secrets). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected
//   automatically by the platform.
// ============================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PULL_TOKEN = Deno.env.get("DATA_PULL_TOKEN") ?? "";

type Json = Record<string, unknown>;

async function sb(path: string, method = "GET", body?: unknown, profileWrite = false) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(method === "GET"
        ? { "Accept-Profile": "genre_reports" }
        : { "Content-Profile": "genre_reports" }),
      ...(profileWrite ? {} : {}),
      ...(method !== "GET" ? { Prefer: "return=representation" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function getKeys(): Promise<Record<string, string>> {
  const rows = await sb("rpc/data_pull_keys", "POST", {});
  const out: Record<string, string> = {};
  for (const r of rows as { name: string; secret: string }[]) out[r.name] = r.secret;
  return out;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (!PULL_TOKEN || req.headers.get("x-pull-token") !== PULL_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as Json;
    const genreSlug = String(body.genre ?? "");
    const topN = Math.min(Number(body.descriptions_top_n ?? 9) || 9, 12);
    if (!genreSlug) return json({ error: "genre is required ('shared' for the cross-genre pack)" }, 400);

    const keys = await getKeys();
    if (!keys.nyt_api_key || !keys.rainforest_api_key) {
      return json({ error: "vault keys missing (nyt_api_key / rainforest_api_key)" }, 500);
    }

    const fetchErrors: Json[] = [];
    const payload: Json = { fetched_at: new Date().toISOString() };
    const humanFetchQueue: Json[] = [
      { source: "k-lytics", note: "manual Dropbox drop only — no API, no scraping (B6 policy)" },
      { source: "conference-and-adaptation-news", note: "researched with citations in stage 2; no API" },
    ];

    if (genreSlug === "shared") {
      // Cross-genre pack: the NYT combined fiction list, for slot-share
      // computations by every genre's analysis step.
      payload.nyt = await pullNyt(["combined-print-and-e-book-fiction"], keys.nyt_api_key, fetchErrors);
    } else {
      const genres = await sb(
        `genres_all?slug=eq.${encodeURIComponent(genreSlug)}&select=slug,display_name,tier,amazon_nodes,nyt_lists`,
      );
      if (!genres.length) return json({ error: `unknown genre '${genreSlug}'` }, 404);
      const g = genres[0] as Json;
      payload.genre = { slug: g.slug, display_name: g.display_name, tier: g.tier };

      payload.nyt = await pullNyt((g.nyt_lists as string[]) ?? [], keys.nyt_api_key, fetchErrors);
      payload.amazon = await pullAmazon(
        (g.amazon_nodes as Json[]) ?? [], keys.rainforest_api_key, topN, fetchErrors,
      );
      if (!((g.amazon_nodes as Json[]) ?? []).length) {
        humanFetchQueue.push({
          source: "amazon-mapping",
          note: `genres_all.amazon_nodes is empty for '${genreSlug}' — record a bestsellers URL mapping first`,
        });
      }
    }

    const sourcesAttempted = genreSlug === "shared" ? 1 : 2;
    if (fetchErrors.length >= sourcesAttempted && sourcesAttempted > 0) {
      // Every source failed: abort the genre (never write an empty pack).
      return json({ error: "all sources failed", fetch_errors: fetchErrors }, 502);
    }

    // Version = 1 + max existing for (genre, month).
    const packMonth = new Date().toISOString().slice(0, 8) + "01";
    const existing = await sb(
      `data_packs?genre_slug=eq.${encodeURIComponent(genreSlug)}&pack_month=eq.${packMonth}&select=version&order=version.desc&limit=1`,
    );
    const version = existing.length ? (existing[0] as { version: number }).version + 1 : 1;

    const rows = await sb("data_packs", "POST", [{
      genre_slug: genreSlug,
      pack_month: packMonth,
      version,
      source: "edge:genre-data-pull",
      payload,
      fetch_errors: fetchErrors,
      human_fetch_queue: humanFetchQueue,
    }]);

    console.log(`data_pack_written genre ${genreSlug} month ${packMonth} version ${version} errors ${fetchErrors.length}`);
    return json({
      ok: true,
      pack_id: (rows[0] as Json).id,
      genre: genreSlug,
      pack_month: packMonth,
      version,
      fetch_errors: fetchErrors,
    });
  } catch (err) {
    console.error("data_pull_exception", (err as Error).stack ?? String(err));
    return json({ error: "internal error" }, 500);
  }
});

// ---------------------------------------------------------------------------
async function pullNyt(lists: string[], key: string, errors: Json[]): Promise<Json> {
  const out: Json = {};
  for (const list of lists) {
    try {
      const res = await fetch(
        `https://api.nytimes.com/svc/books/v3/lists/current/${encodeURIComponent(list)}.json?api-key=${key}`,
      );
      if (!res.ok) throw new Error(`nyt ${list} → ${res.status}`);
      out[list] = await res.json();
      // NYT rate limit: 5 req/min on the Books API — be polite between lists.
      if (lists.length > 1) await sleep(13_000);
    } catch (e) {
      errors.push({ source: `nyt:${list}`, error: String(e) });
    }
  }
  return out;
}

async function pullAmazon(nodes: Json[], key: string, topN: number, errors: Json[]): Promise<Json> {
  const out: Json = { bestsellers: [], new_releases: [], descriptions: [] };
  for (const node of nodes) {
    const url = String(node.url ?? "");
    if (!url) continue;
    try {
      out.bestsellers = await rainforest(key, { type: "bestsellers", url });
      // New-releases page for the same category: extract store + node id from
      // the zgbs URL and build the canonical /gp/new-releases/ URL.
      const m = url.match(/\/zgbs\/([^/]+)\/(\d+)/);
      if (m) {
        const nrUrl = `https://www.amazon.com/gp/new-releases/${m[1]}/${m[2]}`;
        out.new_releases = await rainforest(key, { type: "bestsellers", url: nrUrl });
      }
    } catch (e) {
      errors.push({ source: `rainforest:${url}`, error: String(e) });
      continue;
    }
    // Descriptions for the top N new releases — the hooks-and-tropes raw
    // material. Each is one product request; failures are per-item.
    const items = ((out.new_releases as Json).bestsellers ?? (out.new_releases as Json).results ?? []) as Json[];
    for (const item of items.slice(0, topN)) {
      const asin = String(item.asin ?? "");
      if (!asin) continue;
      try {
        const prod = await rainforest(key, { type: "product", asin, amazon_domain: "amazon.com" });
        (out.descriptions as Json[]).push({
          asin,
          title: (prod as Json).product ? ((prod as Json).product as Json).title : item.title,
          description: (prod as Json).product ? ((prod as Json).product as Json).description : null,
          rank: item.rank,
        });
      } catch (e) {
        errors.push({ source: `rainforest:product:${asin}`, error: String(e) });
      }
    }
  }
  return out;
}

async function rainforest(key: string, params: Record<string, string>): Promise<Json> {
  const qs = new URLSearchParams({ api_key: key, ...params });
  const res = await fetch(`https://api.rainforestapi.com/request?${qs}`);
  if (!res.ok) throw new Error(`rainforest ${params.type} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as Json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
