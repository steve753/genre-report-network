-- =====================================================================
-- REGISTRY CHANGE -- One-click send approval mechanism
-- 2026-09-03 -- PROPOSED -- SQL-EDITOR-SAFE (plain SQL, evidence after COMMIT)
--
-- What this records (one subject, one ruling): Steve ruled 2026-09-03 that
-- the per-send human gate may be exercised through an emailed one-click
-- review console, replacing the terminal dry-run + typed SEND as the
-- primary surface. The gate's SUBSTANCE is unchanged: Steve's review of
-- the rendered copy, Steve's act to dispatch, and no session able to send.
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
              WHERE version = '20260903220000') THEN
    RAISE EXCEPTION 'changelog version 20260903220000 already exists -- applied already, or a stamp clash';
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
                  WHERE subject_path = 'genre_reports.network.pilot_status'
                    AND status = 'in_force') THEN
    RAISE EXCEPTION 'pilot_status ruling missing -- run the pilot-complete change file first';
  END IF;
  IF EXISTS (SELECT 1 FROM registry.decisions
              WHERE subject_path = 'genre_reports.network.send_approval_mechanism') THEN
    RAISE EXCEPTION 'send_approval_mechanism already carries a ruling -- this file has run';
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
    'genre_reports.network.send_approval_mechanism',
    'How the per-send human gate (copy approval + send authorization) is exercised '
    'for Genre Report Network broadcasts.',
    'steve');

  PERFORM registry_admin.record_decision(
    p_decision_id    => v_id,
    p_subject_path   => 'genre_reports.network.send_approval_mechanism',
    p_title          => 'Per-send approval moves to an emailed one-click review console',
    p_ruling         => 'Steve ruled 2026-09-03 (decision dialog: approve sends immediately; '
      || 'notification via a credential-free Worker endpoint) that the per-send human gate is '
      || 'exercised through the review console at reports.stevepieper.com/approve. Mechanism of '
      || 'record: (1) when an issue is published with its send_payload recorded, the pipeline '
      || 'calls POST /api/notify-draft, whose only capability is emailing a fresh review link to '
      || 'the fixed approver address steve@stevepieper.com -- the endpoint holds no credential, '
      || 'is DELIBERATELY OPEN TO UNAUTHENTICATED CALLERS, and mutates nothing but the token '
      || 'hash and notified_at, rate-limited to one notification per issue per hour with a '
      || 'fail-closed cooldown. Known abuse ceiling, accepted: a caller who learns a published '
      || 'issue''s UUID (not exposed on any public page) can trigger at most one '
      || 'approver-addressed email per hour per issue, which also rotates the token and stales '
      || 'earlier links -- the newest email always governs, and no caller can ever obtain a '
      || 'token or cause a send this way; '
      || '(2) the database stores only sha256(token), so sessions with read-only SQL access '
      || 'cannot construct an approve URL -- the raw token exists only in the approver''s inbox; '
      || '(3) GET /approve renders the full dry-run (rendered email, audience count, every gate) '
      || 'and never mutates, per the doi_token_behavior doctrine; (4) POST /approve re-checks '
      || 'every gate server-side, requires a hash of the exact reviewed content (a payload '
      || 'changed after review refuses), requires SEND_AUTH_TOKEN arming, and dispatches through '
      || 'the same executeSend path as the terminal script, with email_log dedup unchanged. '
      || 'The gated send-issue.sh terminal flow remains valid as a fallback surface. The gate''s '
      || 'substance is unchanged: Steve''s review, Steve''s act, sessions unable to send.',
    p_decided_by     => 'steve',
    p_decided_on     => DATE '2026-09-03',
    p_source_doc     => 'Genre Report Network folder, DEPLOY 2026-09-03 PART 6 records; session decision dialog of 2026-09-03 (both options to the recommendation).',
    p_scopes         => ARRAY['skill_genre_report_network'],
    p_status         => 'in_force',
    p_conditions     => '{}'::text[],
    p_source_section => NULL,
    p_effective_note => 'in force on Part 6 deploy; typed-SEND script remains a valid fallback',
    p_recorded_by    => 'system');

  RAISE NOTICE 'RECORDED % on genre_reports.network.send_approval_mechanism', v_id;

  -- Reconcile the pilot_status row (DR-0164), whose ruling text names "his
  -- typed SEND" as the per-send surface. Both rows would otherwise sit
  -- in_force and disagree. The substance (Steve's act) is unchanged; the
  -- surface clause is narrowed by reference rather than left contradictory.
  UPDATE registry.decisions
     SET effective_note = effective_note ||
       '; surface clause superseded 2026-09-03: the typed-SEND wording is exercised through whichever surface genre_reports.network.send_approval_mechanism names (one-click console primary, typed-SEND script fallback)'
   WHERE subject_path = 'genre_reports.network.pilot_status'
     AND status = 'in_force'
     AND effective_note NOT LIKE '%send_approval_mechanism%';
END $rules$;

-- ---------------------------------------------------------------------
-- POST-CHECK
-- ---------------------------------------------------------------------
SET CONSTRAINTS ALL IMMEDIATE;
DO $post$
BEGIN
  IF (SELECT count(*) FROM registry.decisions
       WHERE subject_path = 'genre_reports.network.send_approval_mechanism'
         AND status = 'in_force') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one live send_approval_mechanism ruling';
  END IF;
END $post$;

INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)
VALUES (
  '20260903220000',
  'genre_network_send_approval_mechanism',
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
 WHERE d.subject_path = 'genre_reports.network.send_approval_mechanism';
