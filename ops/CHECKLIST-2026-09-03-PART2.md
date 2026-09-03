# Fully-operational checklist — 2026-09-03 Part 2 (sender + data pull)

Five steps, in this order. Steps 1–3 are yours (each is a paste or a one-liner);
I do everything between them. Nothing sends without your typed SEND at the very end.

## 1. Paste the SQL (Supabase SQL editor)

File: `2026-09-03-sendable-email_log-data_packs.sql`
Creates: `sendable` view (the sender's only audience source), `email_log`
(dedup send record), `data_packs` (stage-1 output), the Vault key accessor,
the Fantasy Issue 001 draft row, and fantasy's Amazon/NYT source mapping
(Amazon Fantasy bestsellers node 16190, verified today).

Paste the whole file, run once. The final grid is the evidence — paste it back
to me. The `fantasy_issue_001` row in that grid is the issue UUID the send
payload will need.

## 2. Deploy the Edge Function (Supabase dashboard)

Dashboard → Edge Functions → Deploy new function:
- Name: `genre-data-pull`
- Paste the contents of `genre-data-pull.index.ts`
- After deploy: function → Secrets → add `DATA_PULL_TOKEN` = a long random
  string you generate (this is the pull trigger key; it stays yours).

Then run the pulls from this folder (uses your anon key + that token, prompted):

    sh pull-data.sh fantasy
    sh pull-data.sh shared

Paste both JSON responses back to me. I read the packs read-only and start
research immediately.

## 3. Deploy the Worker build (this folder)

    sh deploy-2026-09-03-part2.sh

Ships the broadcast sender (POST /api/send-issue) — which answers 503
"sender not armed" until step 5, so this deploy changes nothing user-visible.
The Fantasy Issue 001 pages ship later today via a part-3 deploy after the
adversary rounds clear.

## 4. Subscribe yourself to Fantasy

https://reports.stevepieper.com/fantasy/subscribe/ — subscribe and click the
confirm button in the email. You become the Fantasy list's first confirmed
reader; the pilot's real send goes to you.

## 5. Arm and send (after my copy approval package)

When Issue 001 has cleared the adversary protocol and you've approved the
page and the email copy:
- Cloudflare → Workers → genre-reports → Settings → Variables and Secrets →
  add secret `SEND_AUTH_TOKEN` = a long random string you generate.
  Then Deployments → promote the new version (the secrets gotcha).
- I deliver `send-payload-fantasy-001.json` with the approved copy.
- You run:  `sh send-issue.sh send-payload-fantasy-001.json`
  It always dry-runs first (audience count + full rendered sample), and
  dispatches only after you type SEND.

Verification after the send: the email lands with List-Unsubscribe headers and
exactly one CAN-SPAM address block; `email_log` shows one 'sent' row; running
the script again reports `skipped_already_sent: 1` and sends nothing — the
dedup proof.
