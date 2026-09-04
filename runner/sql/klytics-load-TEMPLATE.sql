-- K-lytics monthly load (attended; ruled 2026-09-04 — runner decisions Q1).
-- Run in the Supabase SQL editor AFTER the month's extract text is prepared
-- by an attended session (corrected table boundaries, zero duplicates).
-- Replace nothing by hand in a paste: the attended session generates this
-- file with the real values filled in before handing it over.
insert into genre_reports.data_packs (genre_slug, pack_month, version, source, payload, fetch_errors, human_fetch_queue)
values (
  'shared',
  date_trunc('month', now() at time zone 'utc')::date,
  -- version is unique per (genre_slug, pack_month) REGARDLESS of source, and
  -- the pg_cron edge pull writes the month's shared pack first - so the next
  -- version is computed across ALL shared rows for the month:
  coalesce((select max(version) + 1 from genre_reports.data_packs
            where genre_slug = 'shared'
              and pack_month = date_trunc('month', now() at time zone 'utc')::date), 1),
  'klytics',
  jsonb_build_object(
    'report_month', '<<the attended session fills this in before delivery>>',
    'extract_text', '<<the attended session fills this in before delivery>>'
  ),
  '[]'::jsonb,
  '[]'::jsonb
)
returning id, pack_month, version;
