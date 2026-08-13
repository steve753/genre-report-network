# Genre Report Network

One Cloudflare Worker serving the entire monthly genre-report publication
network for Polymath Consulting & Publishing.

- **Canonical site:** `reports.stevepieper.com/{genre}/` (genre home = latest
  issue, `rel=canonical` → dated permalink at `/{genre}/{mmm}-{yyyy}`)
- **Vanity hostnames:** `{genre}.stevepieper.com` → 301 to the canonical genre
  home. Unknown proxied hostnames pass through to origin untouched.
- **Double opt-in:** `POST /api/subscribe`, `GET /api/confirm`,
  `GET /api/unsubscribe` — Worker ↔ Supabase (`genre_reports` schema) ↔
  Postmark transactional stream.

Design of record: the "Genre Report Network — Development Path and Feasibility
Review" working document (Cowork session, Aug 2026). Key decisions: §2.6–2.7
URL taxonomy, §2.13 sender identity, §2.16 web construct + paid traffic,
§2.17 Rainforest-native metrics.

## Layout

```
src/index.js            Worker: router + DOI API
public/                 Static assets (issue pages), one folder per genre
config/genres.json      Genre slugs + aliases (mirror of the Supabase registry)
.github/workflows/      Deploy on push via wrangler-action
```

## Deploy

Push to `main`. Requires repo secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Worker runtime secrets (`SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `POSTMARK_TOKEN`, `DOI_SIGNING_SECRET`) are set once
via `wrangler secret put` or the Cloudflare dashboard.

## One-time setup still pending

- [ ] Expose the `genre_reports` schema: Supabase dashboard → Settings → API →
      Exposed schemas → add `genre_reports`.
- [ ] Set the four Worker runtime secrets.
- [ ] DNS: ensure `reports.stevepieper.com` exists as a proxied record
      (A `192.0.2.1` or AAAA `100::` dummy, proxied — the Worker intercepts).
