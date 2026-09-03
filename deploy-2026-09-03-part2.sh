#!/bin/sh
# Genre Report Network — gated production deploy, 2026-09-03 Part 2 (sender).
# Registry: genre_reports.network.deploy_path (attended = disk delivery + gated script).
# Run with:  sh deploy-2026-09-03-part2.sh
set -e
cd "$(dirname "$0")"
echo "Unpacking the Part 2 build..."
rm -rf genre-report-network
tar xzf genre-report-network-2026-09-03-part2.tar.gz
cd genre-report-network
echo ""
echo "This deploys to PRODUCTION at reports.stevepieper.com:"
echo "  - Broadcast sender: POST /api/send-issue (genre_reports.network.dormancy:"
echo "    UNARMED until you set SEND_AUTH_TOKEN — until then it answers 503 and"
echo "    nothing can send). Counted CAN-SPAM block, RFC 8058 headers, email_log"
echo "    dedup, confirmed-only audience via the sendable view."
echo "  - No page changes in this deploy."
echo ""
printf "Type DEPLOY to proceed (anything else aborts): "
read ans
[ "$ans" = "DEPLOY" ] || { echo "Aborted — nothing was deployed."; exit 1; }
npx wrangler@4 deploy
echo ""
echo "Done. Probe: curl -s -X POST https://reports.stevepieper.com/api/send-issue"
echo "should return {\"error\":\"sender not armed\"} — the correct unarmed answer."
