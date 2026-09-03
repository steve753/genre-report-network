#!/bin/sh
# Genre Report Network — gated production deploy, 2026-09-03 Part 3.
# Registry: genre_reports.network.deploy_path (attended = disk delivery + gated script).
# Run with:  sh deploy-2026-09-03-part3.sh
# NOTE: this bundle CONTAINS everything from Part 2 (the unarmed sender), so if
# you have not run the Part 2 deploy yet, this single deploy covers both.
set -e
cd "$(dirname "$0")"
echo "Unpacking the Part 3 build..."
rm -rf genre-report-network
tar xzf genre-report-network-2026-09-03-part3.tar.gz
cd genre-report-network
echo ""
echo "This deploys to PRODUCTION at reports.stevepieper.com:"
echo "  - FANTASY QUARTERLY ISSUE 001: live at /fantasy/q4-2026/, served on the"
echo "    /fantasy/ home, linked from the subscribe page. Cleared two adversary"
echo "    rounds at zero severity-1s. Still noindex until you call launch."
echo "  - Broadcast sender POST /api/send-issue (UNARMED until you set"
echo "    SEND_AUTH_TOKEN; answers 503 until then) — included from Part 2."
echo ""
printf "Type DEPLOY to proceed (anything else aborts): "
read ans
[ "$ans" = "DEPLOY" ] || { echo "Aborted — nothing was deployed."; exit 1; }
npx wrangler@4 deploy
echo ""
echo "Done. Spot-check: https://reports.stevepieper.com/fantasy/ should show Issue 001."
