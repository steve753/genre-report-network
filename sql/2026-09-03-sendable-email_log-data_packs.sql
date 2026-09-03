-- ============================================================================
-- GENRE REPORT NETWORK — sender audience, send log, data packs
-- 2026-09-03 · PROPOSED — Steve pastes into the Supabase SQL editor.
-- Plain SQL only (no psql meta-commands). Evidence SELECT after COMMIT.
--
-- Implements (registry): genre_reports.network.dormancy (sender build),
--   .canspam_address (the sender counts, this schema logs),
--   .stage1_data_pull (data_packs is DR-0159's output table).
-- Session channel is read-only by design; this file is the write path.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Pre-flight: refuse to run twice.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'genre_reports' and table_name = 'email_log') then
    raise exception 'email_log already exists — this change file has already been applied';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. sendable — the ONLY audience source the broadcast sender may read.
--    Confirmed subscribers, with the genre fields the sender needs.
-- ----------------------------------------------------------------------------
create view genre_reports.sendable as
select s.id  as subscriber_id,
       s.email,
       s.first_name,
       s.doi_token,
       s.genre_id,
       g.slug as genre_slug,
       g.display_name,
       g.tier
from genre_reports.subscribers s
join genre_reports.genres_all g on g.id = s.genre_id
where s.status = 'confirmed';

-- ----------------------------------------------------------------------------
-- 2. email_log — one row per delivery attempt; the dedup that makes a repeat
--    send safe. A subscriber with a 'sent' row for an issue is never sent
--    that issue again (partial unique index below enforces it).
-- ----------------------------------------------------------------------------
create table genre_reports.email_log (
  id                  uuid primary key default gen_random_uuid(),
  issue_id            uuid not null references genre_reports.issues(id),
  subscriber_id       uuid not null references genre_reports.subscribers(id),
  message_stream      text not null default 'genre-reports',
  postmark_message_id text,
  status              text not null default 'sent'
                      check (status in ('sent','failed','dry_run')),
  error               text,
  sent_at             timestamptz not null default now()
);

create unique index email_log_sent_once
  on genre_reports.email_log (issue_id, subscriber_id)
  where status = 'sent';

create index email_log_issue on genre_reports.email_log (issue_id);

-- ----------------------------------------------------------------------------
-- 3. data_packs — stage-1 output (genre_reports.network.stage1_data_pull).
--    One versioned pack per genre per month, plus genre_slug='shared' for the
--    cross-genre pack. fetch_errors and human_fetch_queue are first-class:
--    API-less sources land in the queue, never scraped, never silently dropped.
-- ----------------------------------------------------------------------------
create table genre_reports.data_packs (
  id                uuid primary key default gen_random_uuid(),
  genre_slug        text not null,
  pack_month        date not null,
  version           int  not null default 1,
  source            text not null default 'edge:genre-data-pull',
  payload           jsonb not null,
  fetch_errors      jsonb not null default '[]'::jsonb,
  human_fetch_queue jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  unique (genre_slug, pack_month, version)
);

-- ----------------------------------------------------------------------------
-- 4. Grants — custom schemas need explicit service_role grants (skill infra
--    map). The Worker (service key) reads the audience, writes the log; the
--    Edge Function writes packs; sessions read packs read-only.
-- ----------------------------------------------------------------------------
grant select                  on genre_reports.sendable   to service_role;
grant select, insert, update  on genre_reports.email_log  to service_role;
grant select, insert          on genre_reports.data_packs to service_role;

-- ----------------------------------------------------------------------------
-- 5. Fantasy pilot scaffolding:
--    a) Fantasy Issue 001 draft row (month 2026-10-01 = the Q4 2026 issue,
--       slug /fantasy/q4-2026/ — postdated like any October magazine issue
--       appearing in September; Steve's copy approval covers the dating).
--    b) Data-pull source mapping for fantasy: Amazon bestsellers URL for the
--       Rainforest pull, NYT combined fiction list (genre share is computed
--       at analysis time by classification — NYT has no fantasy list).
-- ----------------------------------------------------------------------------
insert into genre_reports.issues (genre_id, month, permalink_url, status)
select g.id, date '2026-10-01',
       'https://reports.stevepieper.com/fantasy/q4-2026/', 'draft'
from genre_reports.genres_all g
where g.slug = 'fantasy'
  and not exists (select 1 from genre_reports.issues i
                  where i.genre_id = g.id and i.month = date '2026-10-01');

update genre_reports.genres_all
set amazon_nodes = '[{"kind":"bestsellers_url","label":"Books > Science Fiction & Fantasy > Fantasy","url":"https://www.amazon.com/Best-Sellers-Books-Fantasy/zgbs/books/16190/"}]'::jsonb,
    nyt_lists    = '["combined-print-and-e-book-fiction"]'::jsonb,
    nyt_lists_note = 'Combined fiction list; fantasy share computed by classification at analysis time (no dedicated NYT fantasy list exists).'
where slug = 'fantasy';

-- ----------------------------------------------------------------------------
-- 6. Vault accessor for the stage-1 Edge Function (DR-0159: "keys from
--    Vault"). SECURITY DEFINER so the function can read exactly these two
--    named secrets and nothing else in the vault; execute granted to
--    service_role only. The keys never leave the Supabase project boundary.
-- ----------------------------------------------------------------------------
create or replace function genre_reports.data_pull_keys()
returns table(name text, secret text)
language sql
security definer
set search_path = ''
as $$
  select s.name, s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name in ('nyt_api_key', 'rainforest_api_key');
$$;

revoke all on function genre_reports.data_pull_keys() from public;
grant execute on function genre_reports.data_pull_keys() to service_role;

commit;

-- ----------------------------------------------------------------------------
-- Evidence (the editor shows only this final grid):
-- ----------------------------------------------------------------------------
select 'sendable_view'  as object, count(*)::text as detail from genre_reports.sendable
union all
select 'email_log_cols', count(*)::text
  from information_schema.columns
  where table_schema='genre_reports' and table_name='email_log'
union all
select 'data_packs_cols', count(*)::text
  from information_schema.columns
  where table_schema='genre_reports' and table_name='data_packs'
union all
select 'fantasy_issue_001', coalesce((
  select i.id::text from genre_reports.issues i
  join genre_reports.genres_all g on g.id=i.genre_id
  where g.slug='fantasy' and i.month=date '2026-10-01'), 'MISSING')
union all
select 'fantasy_amazon_nodes', (
  select amazon_nodes::text from genre_reports.genres_all where slug='fantasy');
