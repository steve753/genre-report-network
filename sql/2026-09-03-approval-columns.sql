-- One-click approval mechanism — issues-table columns + a safe live-test seed.
-- Paste the whole file into the Supabase SQL editor and Run once.
BEGIN;

ALTER TABLE genre_reports.issues
  ADD COLUMN IF NOT EXISTS approval_token_hash text,
  ADD COLUMN IF NOT EXISTS send_payload jsonb,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

COMMENT ON COLUMN genre_reports.issues.approval_token_hash IS
  'sha256 of the raw approval token. The raw token exists only in the emailed link to the approver; storing the hash means read-only sessions cannot construct an approve URL.';
COMMENT ON COLUMN genre_reports.issues.send_payload IS
  'The broadcast payload of record (genre, subject, teaser_bullets, permalink_url). Written by the per-issue telemetry SQL; the approve console renders and hash-binds exactly this.';

CREATE UNIQUE INDEX IF NOT EXISTS issues_approval_token_hash_key
  ON genre_reports.issues (approval_token_hash)
  WHERE approval_token_hash IS NOT NULL;

-- Live-test seed for Thriller 002. PRECONDITION for the "safe test" claim:
-- the send must actually have covered the whole current audience. The
-- evidence grid below prints sent_rows and audience_now — the test is
-- zero-send-risk ONLY IF THEY ARE EQUAL. If audience_now > sent_rows (an
-- aborted send, a new confirm since, or a failed row), the approve page
-- will render a LIVE send button for the remainder; do not use this issue
-- as the test in that case.
UPDATE genre_reports.issues
   SET send_payload = jsonb_build_object(
     'issue_id', 'facd9795-4f59-4eaf-be02-13d9b67918a1',
     'genre', 'thriller',
     'subject', 'Thriller Monthly — Issue 002: Three days to a free awards deadline',
     'teaser_bullets', jsonb_build_array(
       'ITW extended its Thriller Awards deadline to September 6 — self-published works eligible once a free ITW membership application clears',
       'July''s KU page rate fell 8.5% while the fund grew — the bad combination, per Written Word Media''s tracker',
       'Three crime adaptations land on September 16 — Reacher''s finale, all of Neagley, and Slow Horses S6',
       'Bouchercon''s $260 rate expires September 30, and Audible''s year-end clock is 119 days out (no calendar date published)'
     ),
     'permalink_url', 'https://reports.stevepieper.com/thriller/sep-2026/'
   )
 WHERE id = 'facd9795-4f59-4eaf-be02-13d9b67918a1'
   AND send_payload IS NULL;

COMMIT;

SELECT id, status, send_payload IS NOT NULL AS payload_present,
       approval_token_hash IS NOT NULL AS token_present, approved_at, notified_at,
       (SELECT count(*) FROM genre_reports.email_log
         WHERE issue_id = 'facd9795-4f59-4eaf-be02-13d9b67918a1'
           AND status = 'sent') AS sent_rows,
       (SELECT count(*) FROM genre_reports.sendable
         WHERE genre_slug = 'thriller') AS audience_now
  FROM genre_reports.issues
 WHERE id = 'facd9795-4f59-4eaf-be02-13d9b67918a1';
-- Safe test requires sent_rows = audience_now in the grid above.
