-- =====================================================================
-- REGISTRY CHANGE -- Fantasy pilot completion; four-genre batch unblocked
-- 2026-09-03 -- PROPOSED -- SQL-EDITOR-SAFE (plain SQL, evidence after COMMIT)
--
-- What this records (one subject, one ruling): Steve ruled "full pilot
-- today" on 2026-09-03 and the pilot then completed end to end the same
-- day -- Fantasy Quarterly Issue 001 produced under the ruled pipeline
-- (genre_reports.network.model_assignments), verified per
-- genre_reports.network.content_verification (adversary round 1: 5 sev-1
-- fixed; fresh round 2: 6 sev-1 fixed; published at zero), published to
-- /fantasy/q4-2026/, and a REAL SEND executed by Steve through the armed
-- sender (email_log row, Postmark 6aa6e2dd-d026-4340-9826-9ae0497cb4ea).
-- Per genre_reports.network.launch_scope, pilot completion is what clears
-- the remaining four genres for batch production -- this row makes that
-- clearance a registry fact instead of a memory line.
--
-- Run: paste the whole file into the Supabase SQL editor and Run once.
-- On any error the transaction aborts and nothing lands. Paste back the
-- final result grid.
-- =====================================================================

SET lock_timeout = '5s';
SET statement_timeout = '120s';

BEGIN;

-- ---------------------------------------------------------------------
-- PRE-FLIGHT
-- ---------------------------------------------------------------------
DO $pre$
DECLARE n integer;
BEGIN
  IF to_regnamespace('registry') IS NULL THEN
    RAISE EXCEPTION 'schema registry does not exist -- wrong database';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
              WHERE version = '20260903200000') THEN
    RAISE EXCEPTION 'changelog version 20260903200000 already exists -- applied already, or a stamp clash';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM registry.effectivity_conditions
                  WHERE condition_key = 'registry_load_complete' AND met) THEN
    RAISE EXCEPTION 'the registry is not open (registry_load_complete is false)';
  END IF;
  SELECT count(*) INTO n FROM public.actors
   WHERE actor_key = 'steve' AND kind = 'human' AND may_approve AND active;
  IF n <> 1 THEN
    RAISE EXCEPTION 'no active human approver "steve". A ruling is a human act.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM registry.decisions
                  WHERE subject_path = 'genre_reports.network.launch_scope'
                    AND status = 'in_force') THEN
    RAISE EXCEPTION 'launch_scope ruling missing -- run the 1025 MDT change file first';
  END IF;
  IF EXISTS (SELECT 1 FROM registry.decisions
              WHERE subject_path = 'genre_reports.network.pilot_status') THEN
    RAISE EXCEPTION 'pilot_status already carries a ruling -- this file has run';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------
-- The ruling
-- ---------------------------------------------------------------------
DO $rules$
DECLARE v_id text;
BEGIN
  SELECT 'DR-' || lpad((coalesce(max(substring(d.decision_id from 4)::int), 0) + 1)::text, 4, '0')
    INTO v_id FROM registry.decisions d;

  PERFORM registry_admin.add_subject(
    'genre_reports.network.pilot_status',
    'Whether the Fantasy pilot required by genre_reports.network.launch_scope has completed, '
    'and what its completion clears.',
    'steve');

  PERFORM registry_admin.record_decision(
    p_decision_id    => v_id,
    p_subject_path   => 'genre_reports.network.pilot_status',
    p_title          => 'Fantasy pilot completed 2026-09-03; the four-genre batch is cleared',
    p_ruling         => 'Steve ruled "full pilot today" on 2026-09-03 and the pilot completed the same day: '
      || 'Fantasy Quarterly Issue 001 was produced under the ruled model split, verified per '
      || 'genre_reports.network.content_verification (adversary round 1 plus a fresh full-issue round 2, '
      || 'published at zero severity-1 findings), published at /fantasy/q4-2026/ and on the genre home, '
      || 'and a REAL SEND was executed by Steve through the armed broadcast sender to the Fantasy list '
      || '(email_log row of record; Postmark MessageID 6aa6e2dd-d026-4340-9826-9ae0497cb4ea; dedup and '
      || 'counted CAN-SPAM block verified). Per genre_reports.network.launch_scope this clears Romance, '
      || 'Mystery, Science Fiction and Horror for batch production under the batch standard in '
      || 'genre_reports.network.content_verification (two independent adversary rounds plus Steve''s '
      || 'spot-check of the leads). Arming remains per-send: every future send still requires Steve''s '
      || 'copy approval and his typed SEND. The noindex launch gate is unchanged.',
    p_decided_by     => 'steve',
    p_decided_on     => DATE '2026-09-03',
    p_source_doc     => 'Genre Report Network folder, DEPLOY 2026-09-03 PART 2 and PART 3 records; session evidence of 2026-09-03 (pilot ruling via decision dialog; send executed by operator).',
    p_scopes         => ARRAY['skill_genre_report_network'],
    p_status         => 'in_force',
    p_conditions     => '{}'::text[],
    p_source_section => NULL,
    p_effective_note => 'in force now; batch production authorized, per-send gates unchanged',
    p_recorded_by    => 'system');

  RAISE NOTICE 'RECORDED % on genre_reports.network.pilot_status', v_id;
END $rules$;

-- ---------------------------------------------------------------------
-- POST-CHECK
-- ---------------------------------------------------------------------
SET CONSTRAINTS ALL IMMEDIATE;
DO $post$
BEGIN
  IF (SELECT count(*) FROM registry.decisions
       WHERE subject_path = 'genre_reports.network.pilot_status'
         AND status = 'in_force') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one live pilot_status ruling';
  END IF;
END $post$;

INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)
VALUES (
  '20260903200000',
  'genre_network_pilot_complete',
  ARRAY['-- applied by hand via the Supabase SQL editor; the file of record is in the '
        'Production Configuration folder under this name'],
  'sql-editor/operator'
);

COMMIT;

-- ---------------------------------------------------------------------
-- EVIDENCE (final grid -- paste it back)
-- ---------------------------------------------------------------------
SELECT d.decision_id, d.subject_path, d.status, d.effective_note
  FROM registry.decisions d
 WHERE d.subject_path = 'genre_reports.network.pilot_status';
