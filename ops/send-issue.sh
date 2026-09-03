#!/bin/sh
# Gated broadcast send (registry: genre_reports.network.dormancy — arming and
# each send are Steve's acts; genre_reports.network.canspam_address — the
# Worker counts the address block and refuses a malformed send).
#
# Usage:  sh send-issue.sh <payload.json>
# Always dry-runs first and shows you the audience + rendered sample.
# Nothing dispatches until you then type SEND.
set -e
PAYLOAD="${1:?usage: sh send-issue.sh <payload.json>}"
[ -f "$PAYLOAD" ] || { echo "payload file not found: $PAYLOAD"; exit 1; }

if [ -z "$SEND_AUTH_TOKEN" ]; then
  printf "SEND_AUTH_TOKEN (the Worker secret you set): "
  stty -echo; read SEND_AUTH_TOKEN; stty echo; echo ""
fi

ENDPOINT="https://reports.stevepieper.com/api/send-issue"

echo "--- DRY RUN ---------------------------------------------------------"
DRY=$(python3 -c "import json,sys; d=json.load(open('$PAYLOAD')); d['dry_run']=True; print(json.dumps(d))")
curl -sS -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $SEND_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$DRY" | python3 -c "
import json,sys
r = json.load(sys.stdin)
if not r.get('ok'):
    print('DRY RUN REFUSED:', r); sys.exit(1)
print('audience:', r['audience'], '· already sent (skipped):', r['skipped_already_sent'])
s = r.get('sample')
if s:
    print('sample To:', s['To'])
    print('sample Subject:', s['Subject'])
    print()
    print(s['TextBody'])
else:
    print('audience is empty — nothing would be sent')
"
echo "---------------------------------------------------------------------"
printf "Type SEND to dispatch to the live list (anything else aborts): "
read ans
[ "$ans" = "SEND" ] || { echo "Aborted — nothing was sent."; exit 1; }

curl -sS -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $SEND_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD"
echo ""
echo "Done. Check genre_reports.email_log for the per-recipient record."
