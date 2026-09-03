-- =====================================================================
-- REGISTRY CHANGE -- Genre write lane + pre-approval page visibility
-- 2026-09-03 -- PROPOSED -- SQL-EDITOR-SAFE (plain SQL, evidence after COMMIT)
--
-- Two subjects, two rulings, both from Steve's 2026-09-03 decision dialog
-- (both options to the recommendation) after he ruled the target workflow:
-- his ONLY per-issue act is the one-click approval; deploys and SQL pastes
-- come off his plate.
--
-- Run: paste the whole file into the Supabase SQL editor and Run once.
-- Paste back the final result grid.
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
              WHERE version = '20260903230000') THEN
    RAISE EXCEPTION 'changelog version 20260903230000 already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM registry.effectivity_conditions
                  WHERE condition_key = 'registry_load_complete' AND met) THEN
    RAISE EXCEPTION 'the registry is not open';
  END IF;
  SELECT count(*) INTO n FROM public.actors
   WHERE actor_key = 'steve' AND kind = 'human' AND may_approve AND active;
  IF n <> 1 THEN
    RAISE EXCEPTION 'no active human approver "steve"';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM registry.decisions
                  WHERE subject_path = 'genre_reports.network.send_approval_mechanism'
                    AND status = 'in_force') THEN
    RAISE EXCEPTION 'send_approval_mechanism ruling missing -- run that change file first';
  END IF;
  IF EXISTS (SELECT 1 FROM registry.decisions
              WHERE subject_path IN ('genre_reports.network.write_lane',
                                     'genre_reports.network.publish_visibility')) THEN
    RAISE EXCEPTION 'write_lane or publish_visibility already ruled -- this file has run';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------
-- Ruling 1: the write lane
-- ---------------------------------------------------------------------
DO $r1$
DECLARE v_id text;
BEGIN
  SELECT 'DR-' || lpad((coalesce(max(substring(d.decision_id from 4)::int), 0) + 1)::text, 4, '0')
    INTO v_id FROM registry.decisions d;

  PERFORM registry_admin.add_subject(
    'genre_reports.network.write_lane',
    'How pipeline sessions write issue-publication state to the genre_reports schema.',
    'steve');

  PERFORM registry_admin.record_decision(
    p_decision_id    => v_id,
    p_subject_path   => 'genre_reports.network.write_lane',
    p_title          => 'Genre write lane replaces per-issue operator SQL pastes',
    p_ruling         => 'Steve ruled 2026-09-03 that per-issue publication state is written through '
      || 'a dedicated write lane, mirroring The Dangle''s ruled pattern: a Cloudflare Worker '
      || '("genre-write", workers.dev only, shared token in the connector URL because the '
      || 'connector UI reserves the Authorization header) exposing exactly two MCP tools -- '
      || 'genre_write_probe and genre_record_issue_published -- each backed by a SECURITY DEFINER '
      || 'function whose gates are enforced in Postgres (draft-only with idempotent re-call, '
      || 'genre match, 3-6 non-empty teasers, canonical permalink). Sessions retain no raw SQL '
      || 'write access. THE APPROVAL FIELDS HAVE NO TOOL BY DESIGN: approved_at, approved_by and '
      || 'approval_token_hash are written only by the approval mechanism in the publication '
      || 'Worker (the notify endpoint and the one-click console), and SEND_AUTH_TOKEN arming is '
      || 'a different Worker''s secret. Blast radius of a compromised lane token, stated exactly: '
      || 'it can mark an issue published and author the payload a later broadcast would carry -- '
      || 'it cannot approve, arm, or dispatch, and the payload is rendered in full on the '
      || 'approval console and hash-bound to the approver''s click, so nothing it writes reaches '
      || 'subscribers unread. Accepted consequence of the token-in-URL transport: the token '
      || 'appears in Cloudflare''s own request logs, as it does for the Dangle lane. Operator '
      || 'SQL pastes remain valid as fallback.',
    p_decided_by     => 'steve',
    p_decided_on     => DATE '2026-09-03',
    p_source_doc     => 'Genre Report Network folder, DEPLOY 2026-09-03 PART 7 records; session decision dialog of 2026-09-03.',
    p_scopes         => ARRAY['skill_genre_report_network'],
    p_status         => 'in_force',
    p_conditions     => '{}'::text[],
    p_source_section => NULL,
    p_effective_note => 'in force now as the ruled design; until the genre-write Worker is deployed and its connector added, the SQL-paste fallback is the operative write path',
    p_recorded_by    => 'system');

  RAISE NOTICE 'RECORDED % on genre_reports.network.write_lane', v_id;
END $r1$;

-- ---------------------------------------------------------------------
-- Ruling 2: page visibility before approval
-- ---------------------------------------------------------------------
DO $r2$
DECLARE v_id text;
BEGIN
  SELECT 'DR-' || lpad((coalesce(max(substring(d.decision_id from 4)::int), 0) + 1)::text, 4, '0')
    INTO v_id FROM registry.decisions d;

  PERFORM registry_admin.add_subject(
    'genre_reports.network.publish_visibility',
    'Whether issue pages may serve publicly before Steve''s per-send approval click.',
    'steve');

  PERFORM registry_admin.record_decision(
    p_decision_id    => v_id,
    p_subject_path   => 'genre_reports.network.publish_visibility',
    p_title          => 'Pages go live on pipeline deploy; the approval click gates the email only',
    p_ruling         => 'Steve ruled 2026-09-03 that issue pages (dated permalink AND the genre '
      || 'home flip) publish when the pipeline deploys, BEFORE his approval click; the one-click '
      || 'approval gates the email broadcast only. Basis, recorded so the trade-off stays '
      || 'visible: every page carries noindex pre-launch and organic traffic is negligible, the '
      || 'two-adversary-round verification standard precedes any deploy, and the dated '
      || 'correction-note precedent covers post-hoc fixes. THIS RULING IS EXPLICITLY '
      || 'PRE-LAUNCH-SCOPED: it must be re-put to Steve as part of the public-launch decision '
      || '(when noindex comes off), where a hold-the-home-until-approve mechanism was already '
      || 'sketched as the alternative.',
    p_decided_by     => 'steve',
    p_decided_on     => DATE '2026-09-03',
    p_source_doc     => 'Genre Report Network folder, DEPLOY 2026-09-03 PART 7 records; session decision dialog of 2026-09-03.',
    p_scopes         => ARRAY['skill_genre_report_network'],
    p_status         => 'in_force',
    p_conditions     => '{}'::text[],
    p_source_section => NULL,
    p_effective_note => 'in force now, pre-launch scope; re-decide at public launch',
    p_recorded_by    => 'system');

  RAISE NOTICE 'RECORDED % on genre_reports.network.publish_visibility', v_id;
END $r2$;

-- ---------------------------------------------------------------------
-- POST-CHECK
-- ---------------------------------------------------------------------
SET CONSTRAINTS ALL IMMEDIATE;
DO $post$
BEGIN
  IF (SELECT count(*) FROM registry.decisions
       WHERE subject_path IN ('genre_reports.network.write_lane',
                              'genre_reports.network.publish_visibility')
         AND status = 'in_force') <> 2 THEN
    RAISE EXCEPTION 'expected exactly two new live rulings';
  END IF;
END $post$;

INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)
VALUES (
  '20260903230000',
  'genre_network_write_lane_and_publish_visibility',
  ARRAY['-- applied by hand via the Supabase SQL editor; the file of record is in the '
        'Production Configuration folder under this name'],
  'sql-editor/operator'
);

COMMIT;

-- EVIDENCE (final grid -- paste it back)
SELECT d.decision_id, d.subject_path, d.status, d.effective_note
  FROM registry.decisions d
 WHERE d.subject_path IN ('genre_reports.network.write_lane',
                          'genre_reports.network.publish_visibility')
 ORDER BY d.decision_id;
