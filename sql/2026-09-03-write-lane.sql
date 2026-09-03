-- Genre write lane — Postgres side. Paste into the Supabase SQL editor, Run once.
-- Pattern of record: The Dangle write lane (DR-0082 lineage) — sessions hold no
-- raw write access; writes go through narrow SECURITY DEFINER functions whose
-- gates live HERE, in the database, not in the caller. The approval fields
-- (approved_at, approved_by, approval_token_hash) deliberately have NO function:
-- the one-click console is their only writer.
BEGIN;

CREATE TABLE IF NOT EXISTS genre_reports.write_probe_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  probed_at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE OR REPLACE FUNCTION genre_reports.write_probe(p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = genre_reports, pg_temp
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO genre_reports.write_probe_log (note) VALUES (left(p_note, 200))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'probe_id', v_id, 'at', now());
END $$;

-- The lane's one real tool: record an issue's publication. Gates:
--   G1 issue exists and is a draft (double-publish refuses; identical re-call
--      after success returns ok/already so the pipeline is retry-safe)
--   G2 payload genre matches the issue's own genre
--   G3 subject present; 3..6 teaser bullets, each non-empty
--   G4 permalink lives under the genre's canonical path
-- On pass: status -> published, published_at stamped, send_payload + telemetry
-- recorded. It NEVER touches approval fields and NEVER sends anything.
CREATE OR REPLACE FUNCTION genre_reports.record_issue_published(
  p_issue_id uuid,
  p_send_payload jsonb,
  p_adversary_rounds smallint DEFAULT NULL,
  p_adversary_verdict text DEFAULT NULL,
  p_story_count smallint DEFAULT NULL,
  p_production_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = genre_reports, pg_temp
AS $$
DECLARE
  v_issue genre_reports.issues%ROWTYPE;
  v_slug text;
  v_subject text;
  v_permalink text;
  v_bullets jsonb;
  v_n int;
BEGIN
  SELECT * INTO v_issue FROM genre_reports.issues WHERE id = p_issue_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown issue');
  END IF;

  SELECT g.slug INTO v_slug FROM genre_reports.genres_all g WHERE g.id = v_issue.genre_id;
  -- Fail CLOSED (adversary finding 1): a NULL slug would make the genre and
  -- permalink gates evaluate to NULL and silently skip.
  IF v_slug IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'issue has no resolvable genre');
  END IF;

  -- Idempotent success: same payload already recorded.
  IF v_issue.status = 'published' AND v_issue.send_payload = p_send_payload THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'issue_id', p_issue_id,
                              'published_at', v_issue.published_at);
  END IF;
  IF v_issue.status <> 'draft' THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('issue status is %L, not draft — publication is recorded once', v_issue.status));
  END IF;

  IF length(p_send_payload::text) > 16384 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'send_payload too large (16KB cap)');
  END IF;

  v_subject   := btrim(coalesce(p_send_payload->>'subject', ''));
  v_permalink := coalesce(p_send_payload->>'permalink_url', '');
  v_bullets   := p_send_payload->'teaser_bullets';

  IF coalesce(p_send_payload->>'genre', '') <> v_slug THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('payload genre %L does not match issue genre %L',
                      p_send_payload->>'genre', v_slug));
  END IF;
  IF v_subject = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'subject is required');
  END IF;
  IF v_bullets IS NULL OR jsonb_typeof(v_bullets) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'teaser_bullets must be an array');
  END IF;
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(v_bullets) b
   WHERE jsonb_typeof(b) = 'string' AND btrim(b #>> '{}') <> '';
  IF v_n < 3 OR v_n > 6 OR v_n <> jsonb_array_length(v_bullets) THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('need 3..6 non-empty teaser bullets, got %s (%s non-empty)',
                      jsonb_array_length(v_bullets), v_n));
  END IF;
  IF position(('https://reports.stevepieper.com/' || v_slug || '/') in v_permalink) <> 1 THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'permalink_url must live under the genre''s canonical path');
  END IF;

  UPDATE genre_reports.issues
     SET status            = 'published',
         published_at      = now(),
         send_payload      = p_send_payload,
         adversary_rounds  = coalesce(p_adversary_rounds, adversary_rounds),
         adversary_verdict = coalesce(p_adversary_verdict, adversary_verdict),
         story_count       = coalesce(p_story_count, story_count),
         production_notes  = coalesce(p_production_notes, production_notes)
   WHERE id = p_issue_id;

  RETURN jsonb_build_object('ok', true, 'issue_id', p_issue_id, 'genre', v_slug,
                            'status', 'published', 'published_at', now());
END $$;

-- Lock the lane down: nothing callable by anon/authenticated; only the
-- service role (held by the genre-write Worker as a secret) may execute.
REVOKE ALL ON FUNCTION genre_reports.write_probe(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION genre_reports.record_issue_published(uuid, jsonb, smallint, text, smallint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION genre_reports.write_probe(text) TO service_role;
GRANT EXECUTE ON FUNCTION genre_reports.record_issue_published(uuid, jsonb, smallint, text, smallint, text) TO service_role;
REVOKE ALL ON TABLE genre_reports.write_probe_log FROM PUBLIC, anon, authenticated;
-- No table grants: the SECURITY DEFINER owner does the inserting, and a
-- direct-REST surface on this table is not wanted. RLS on (no policies) so a
-- future blanket GRANT cannot silently open it.
ALTER TABLE genre_reports.write_probe_log ENABLE ROW LEVEL SECURITY;
ALTER FUNCTION genre_reports.write_probe(text) OWNER TO postgres;
ALTER FUNCTION genre_reports.record_issue_published(uuid, jsonb, smallint, text, smallint, text) OWNER TO postgres;

COMMIT;

-- EVIDENCE (paste back). The security property IS the grant set: the
-- correct grid shows anon_can=f, authd_can=f, svc_can=t on both rows,
-- secdef=t, and search_path pinned.
SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS search_path_pin,
       pg_get_userbyid(p.proowner) AS owner,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authd_can,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc_can
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'genre_reports'
   AND p.proname IN ('write_probe', 'record_issue_published')
 ORDER BY p.proname;
